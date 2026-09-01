"""Small stdlib-only client for the Dream Worker 0.8.x control API."""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping
from typing import Any
from urllib import error as urllib_error
from urllib import request as urllib_request
from urllib.parse import urlsplit


DEFAULT_TIMEOUT_SECONDS = 10.0
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
JOB_ID_RE = re.compile(r"^[0-9a-fA-F]{32}$")


class DreamWorkerError(RuntimeError):
    """Normalized Dream Worker transport or API failure."""

    def __init__(
        self,
        status: int | None,
        code: str,
        message: str,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = str(code)
        self.message = str(message)


class DreamWorkerClient:
    """Authenticated client for status and persistent Dream Worker jobs."""

    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        opener: Callable[..., Any] = urllib_request.urlopen,
    ) -> None:
        self.base_url = self._normalize_base_url(base_url)
        self._token = self._validate_token(token)
        self.timeout = float(timeout)
        self._opener = opener

        if self.timeout <= 0:
            raise ValueError("timeout must be greater than zero")

    @staticmethod
    def _normalize_base_url(value: str) -> str:
        raw = str(value or "").strip().rstrip("/")
        if not raw:
            raise ValueError("Dream Worker base URL is required")

        parts = urlsplit(raw)

        if parts.scheme not in {"http", "https"}:
            raise ValueError("Dream Worker base URL must use http or https")

        if not parts.hostname:
            raise ValueError("Dream Worker base URL must include a host")

        if parts.username or parts.password:
            raise ValueError("Dream Worker base URL must not contain credentials")

        if parts.query or parts.fragment:
            raise ValueError("Dream Worker base URL must not contain query or fragment")

        path = parts.path.rstrip("/")
        if path:
            raise ValueError("Dream Worker base URL must not contain a path")

        return raw

    @staticmethod
    def _validate_token(value: str) -> str:
        token = str(value or "").strip()

        if not token:
            raise ValueError("Dream Worker token is required")

        if any(ord(char) < 33 or ord(char) == 127 for char in token):
            raise ValueError("Dream Worker token contains invalid characters")

        return token

    @staticmethod
    def _validate_job_id(value: str) -> str:
        job_id = str(value or "").strip()

        if JOB_ID_RE.fullmatch(job_id) is None:
            raise ValueError("Dream Worker job id must be 32 hexadecimal characters")

        return job_id

    @staticmethod
    def _decode_json(raw: bytes) -> Mapping[str, Any]:
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise DreamWorkerError(
                None,
                "invalid_response",
                f"Dream Worker returned invalid JSON: {exc}",
            ) from exc

        if not isinstance(payload, Mapping):
            raise DreamWorkerError(
                None,
                "invalid_response",
                "Dream Worker response must be a JSON object",
            )

        return payload

    @staticmethod
    def _read_limited(response: Any) -> bytes:
        raw = response.read(MAX_RESPONSE_BYTES + 1)

        if len(raw) > MAX_RESPONSE_BYTES:
            raise DreamWorkerError(
                None,
                "response_too_large",
                "Dream Worker response exceeded the safety limit",
            )

        return raw

    @staticmethod
    def _error_from_http(exc: urllib_error.HTTPError) -> DreamWorkerError:
        raw = b""

        try:
            raw = exc.read(MAX_RESPONSE_BYTES + 1)
        except Exception:
            raw = b""

        code = "http_error"
        message = f"Dream Worker returned HTTP {int(exc.code)}"

        if raw and len(raw) <= MAX_RESPONSE_BYTES:
            try:
                payload = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                payload = None

            if isinstance(payload, Mapping):
                api_code = payload.get("error")
                detail = payload.get("detail") or payload.get("message")

                if isinstance(api_code, str) and api_code.strip():
                    code = api_code.strip()

                if isinstance(detail, str) and detail.strip():
                    message = detail.strip()

                if code != "http_error" and message.startswith("Dream Worker returned HTTP"):
                    message = code

        return DreamWorkerError(
            int(exc.code),
            code,
            message,
        )

    def _request(
        self,
        method: str,
        path: str,
        payload: Mapping[str, Any] | None = None,
    ) -> Mapping[str, Any]:
        data = None
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self._token}",
            "User-Agent": "ODS DreamWorkerClient/1",
        }

        if payload is not None:
            data = json.dumps(
                dict(payload),
                separators=(",", ":"),
            ).encode("utf-8")
            headers["Content-Type"] = "application/json; charset=utf-8"

        request = urllib_request.Request(
            f"{self.base_url}{path}",
            data=data,
            headers=headers,
            method=method.upper(),
        )

        try:
            with self._opener(
                request,
                timeout=self.timeout,
            ) as response:
                raw = self._read_limited(response)
        except urllib_error.HTTPError as exc:
            raise self._error_from_http(exc) from exc
        except (TimeoutError, urllib_error.URLError, OSError) as exc:
            raise DreamWorkerError(
                None,
                "worker_unreachable",
                f"Dream Worker request failed: {exc}",
            ) from exc

        result = self._decode_json(raw)

        if result.get("ok") is False:
            api_code = result.get("error")
            code = str(api_code or "worker_error")
            raise DreamWorkerError(
                None,
                code,
                code,
            )

        return result

    @staticmethod
    def _extract_job(payload: Mapping[str, Any]) -> dict[str, Any]:
        nested = payload.get("job")

        if isinstance(nested, Mapping):
            return dict(nested)

        if isinstance(payload.get("id"), str) and isinstance(payload.get("state"), str):
            return dict(payload)

        raise DreamWorkerError(
            None,
            "invalid_job_response",
            "Dream Worker response did not contain a job object",
        )

    def status(self) -> dict[str, Any]:
        return dict(
            self._request(
                "GET",
                "/status",
            )
        )

    def submit_job(
        self,
        prompt: str,
        *,
        enable_thinking: bool = False,
        max_tokens: int = 512,
    ) -> dict[str, Any]:
        text = str(prompt or "")

        if not text.strip():
            raise ValueError("prompt must not be empty")

        if type(max_tokens) is not int or max_tokens < 1:
            raise ValueError("max_tokens must be a positive integer")

        response = self._request(
            "POST",
            "/jobs",
            {
                "prompt": text,
                "enableThinking": bool(enable_thinking),
                "maxTokens": max_tokens,
            },
        )

        return self._extract_job(response)

    def get_job(self, job_id: str) -> dict[str, Any]:
        safe_id = self._validate_job_id(job_id)
        response = self._request(
            "GET",
            f"/jobs/{safe_id}",
        )
        return self._extract_job(response)

    def cancel_job(self, job_id: str) -> dict[str, Any]:
        safe_id = self._validate_job_id(job_id)
        response = self._request(
            "POST",
            f"/jobs/{safe_id}/cancel",
        )
        return self._extract_job(response)


__all__ = [
    "DEFAULT_TIMEOUT_SECONDS",
    "DreamWorkerClient",
    "DreamWorkerError",
]