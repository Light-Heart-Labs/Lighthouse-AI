"""Unit tests for the stdlib-only Dream Worker client."""

from __future__ import annotations

import io
import json
import sys
import unittest
from pathlib import Path
from urllib import error as urllib_error


ODS_ROOT = Path(__file__).resolve().parents[1]
BIN_DIR = ODS_ROOT / "bin"

if str(BIN_DIR) not in sys.path:
    sys.path.insert(0, str(BIN_DIR))

from dream_worker.client import DreamWorkerClient, DreamWorkerError


JOB_ID = "6f250f8f0bdf43da8a3f619b3a31184b"


class FakeResponse:
    def __init__(self, payload: dict, status: int = 200) -> None:
        self.status = status
        self.headers = {"content-type": "application/json"}
        self._body = json.dumps(payload).encode("utf-8")

    def read(self, size: int = -1) -> bytes:
        if size < 0:
            return self._body
        return self._body[:size]

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        return False


class RecordingOpener:
    def __init__(self, payload: dict) -> None:
        self.payload = payload
        self.calls = []

    def __call__(self, request, timeout):
        self.calls.append((request, timeout))
        return FakeResponse(self.payload)


class DreamWorkerClientTests(unittest.TestCase):
    def test_status_sends_bearer_token(self) -> None:
        opener = RecordingOpener(
            {
                "version": "0.8.0",
                "machine": "WOLFSOUL-PRIME",
                "machineState": "INTERACTIVE",
            }
        )
        client = DreamWorkerClient(
            "http://192.168.1.19:18100",
            "a" * 64,
            opener=opener,
        )

        result = client.status()

        self.assertEqual(result["version"], "0.8.0")
        request, timeout = opener.calls[0]
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(request.full_url, "http://192.168.1.19:18100/status")
        self.assertEqual(request.get_header("Authorization"), "Bearer " + ("a" * 64))
        self.assertEqual(timeout, 10.0)

    def test_submit_job_uses_worker_contract_and_unwraps_job(self) -> None:
        opener = RecordingOpener(
            {
                "ok": True,
                "job": {
                    "id": JOB_ID,
                    "state": "queued",
                    "attemptCount": 0,
                },
            }
        )
        client = DreamWorkerClient(
            "http://192.168.1.19:18100",
            "b" * 64,
            opener=opener,
        )

        job = client.submit_job(
            "Reply with exactly: OK",
            enable_thinking=False,
            max_tokens=64,
        )

        self.assertEqual(job["id"], JOB_ID)
        self.assertEqual(job["state"], "queued")

        request, _timeout = opener.calls[0]
        payload = json.loads(request.data.decode("utf-8"))

        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.full_url, "http://192.168.1.19:18100/jobs")
        self.assertEqual(payload["prompt"], "Reply with exactly: OK")
        self.assertIs(payload["enableThinking"], False)
        self.assertEqual(payload["maxTokens"], 64)

    def test_get_job_accepts_nested_job_response(self) -> None:
        opener = RecordingOpener(
            {
                "ok": True,
                "job": {
                    "id": JOB_ID,
                    "state": "completed",
                    "content": "OK",
                },
            }
        )
        client = DreamWorkerClient(
            "http://192.168.1.19:18100",
            "c" * 64,
            opener=opener,
        )

        job = client.get_job(JOB_ID)

        self.assertEqual(job["state"], "completed")
        self.assertEqual(job["content"], "OK")

    def test_get_job_accepts_direct_job_response(self) -> None:
        opener = RecordingOpener(
            {
                "id": JOB_ID,
                "state": "queued",
                "attemptCount": 0,
            }
        )
        client = DreamWorkerClient(
            "http://192.168.1.19:18100",
            "d" * 64,
            opener=opener,
        )

        job = client.get_job(JOB_ID)

        self.assertEqual(job["id"], JOB_ID)
        self.assertEqual(job["state"], "queued")

    def test_cancel_job_uses_cancel_endpoint(self) -> None:
        opener = RecordingOpener(
            {
                "ok": True,
                "job": {
                    "id": JOB_ID,
                    "state": "cancelled",
                },
            }
        )
        client = DreamWorkerClient(
            "http://192.168.1.19:18100",
            "e" * 64,
            opener=opener,
        )

        job = client.cancel_job(JOB_ID)

        self.assertEqual(job["state"], "cancelled")
        request, _timeout = opener.calls[0]
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(
            request.full_url,
            f"http://192.168.1.19:18100/jobs/{JOB_ID}/cancel",
        )

    def test_http_401_is_normalized_without_leaking_token(self) -> None:
        token = "f" * 64

        def opener(request, timeout):
            body = io.BytesIO(
                b'{"ok":false,"error":"unauthorized"}'
            )
            raise urllib_error.HTTPError(
                request.full_url,
                401,
                "Unauthorized",
                {},
                body,
            )

        client = DreamWorkerClient(
            "http://192.168.1.19:18100",
            token,
            opener=opener,
        )

        with self.assertRaises(DreamWorkerError) as caught:
            client.status()

        self.assertEqual(caught.exception.status, 401)
        self.assertEqual(caught.exception.code, "unauthorized")
        self.assertNotIn(token, str(caught.exception))

    def test_rejects_path_in_job_id(self) -> None:
        opener = RecordingOpener({"ok": True})
        client = DreamWorkerClient(
            "http://192.168.1.19:18100",
            "1" * 64,
            opener=opener,
        )

        with self.assertRaises(ValueError):
            client.get_job("../../status")

        self.assertEqual(opener.calls, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)