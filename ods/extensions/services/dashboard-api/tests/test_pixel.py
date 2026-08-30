"""Security and streaming contracts for the Pixel dashboard bridge."""

from __future__ import annotations

import asyncio
import json
import os
import pathlib
import sys
from unittest.mock import patch

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError


os.environ.setdefault("DASHBOARD_API_KEY", "dashboard-test-key")
os.environ.setdefault("ODS_INSTALL_DIR", "/tmp/ods-test-install")
os.environ.setdefault("ODS_DATA_DIR", "/tmp/ods-test-data")
os.environ.setdefault("ODS_EXTENSIONS_DIR", "/tmp/ods-test-extensions")
os.environ.setdefault("GPU_BACKEND", "nvidia")
os.environ.setdefault("ODS_MODE", "local")

DASHBOARD_API_DIR = str(pathlib.Path(__file__).resolve().parent.parent)
sys.path.insert(0, DASHBOARD_API_DIR)

from routers import pixel  # noqa: E402
import pixel_runtime_state  # noqa: E402
from pixel_runtime_state import pixel_stream_active  # noqa: E402


EDGE_KEY = "e" * 64


class FakeResponse:
    def __init__(self, status=200, content_type="application/json", chunks=()):
        self.status_code = status
        self.headers = {"content-type": content_type}
        self._chunks = list(chunks)

    async def aiter_bytes(self):
        for chunk in self._chunks:
            yield chunk


class FakeStreamContext:
    def __init__(self, response):
        self.response = response

    async def __aenter__(self):
        return self.response

    async def __aexit__(self, *_args):
        return False


class FakeClient:
    def __init__(self, response, capture=None):
        self.response = response
        self.capture = capture

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    async def aclose(self):
        return None

    def stream(self, method, url, **kwargs):
        if self.capture is not None:
            self.capture.update({"method": method, "url": url, **kwargs})
        return FakeStreamContext(self.response)


class CancelAwareClient(FakeClient):
    def __init__(self, response, calls):
        super().__init__(response)
        self.calls = calls

    def stream(self, method, url, **kwargs):
        self.calls.append({"method": method, "url": url, **kwargs})
        if url.endswith("/v1/chat/cancel"):
            return FakeStreamContext(
                FakeResponse(
                    content_type="application/json",
                    chunks=[b'{"aborted":true}'],
                )
            )
        return FakeStreamContext(self.response)


class ConnectedRequest:
    async def is_disconnected(self):
        return False


class DisconnectedRequest:
    async def is_disconnected(self):
        return True


class SilentResponse(FakeResponse):
    def __init__(self):
        super().__init__(content_type="text/event-stream")
        self.cancelled = asyncio.Event()

    async def aiter_bytes(self):
        try:
            await asyncio.Future()
        finally:
            self.cancelled.set()
        yield b""  # pragma: no cover - keeps this an async generator


async def stream_body(response):
    return b"".join([chunk async for chunk in response.body_iterator])


@pytest.fixture(autouse=True)
def pixel_env(monkeypatch):
    monkeypatch.setenv("PIXEL_OPENWEBUI_KEY", EDGE_KEY)
    monkeypatch.setenv("PIXEL_EDGE_URL", "http://pixel-edge:9595")

    async def idle_model_lifecycle(*_args, **_kwargs):
        return {"status": "idle", "lifecycleActive": False, "activeOperation": None}

    monkeypatch.setattr(pixel, "request_agent_json", idle_model_lifecycle)


@pytest.mark.parametrize(
    "value",
    [
        "https://pixel-edge:9595",
        "http://other:9595",
        "http://pixel-edge:8080",
        "http://user:pass@pixel-edge:9595",
        "http://pixel-edge:9595/path",
        "http://pixel-edge:9595?query=1",
        "http://pixel-edge:9595#fragment",
        "http://pixel-edge:notaport",
    ],
)
def test_edge_url_rejects_every_origin_escape(value):
    with pytest.raises(ValueError):
        pixel._validate_edge_url(value)


def test_pixel_config_is_optional_but_strict(monkeypatch):
    monkeypatch.delenv("PIXEL_OPENWEBUI_KEY", raising=False)
    assert pixel._pixel_config() is None
    for value in ("short", f" {EDGE_KEY}", f"{EDGE_KEY}\n", "x" * 4097):
        monkeypatch.setenv("PIXEL_OPENWEBUI_KEY", value)
        with pytest.raises(RuntimeError):
            pixel._pixel_config()


def test_request_schema_forbids_extra_fields_and_unsafe_ids():
    with pytest.raises(ValidationError):
        pixel.ChatStreamRequest.model_validate(
            {"chat_id": "safe", "messages": [{"role": "user", "content": "ok", "extra": 1}]}
        )
    with pytest.raises(ValidationError):
        pixel.ChatStreamRequest.model_validate(
            {"chat_id": "../../escape", "messages": [{"role": "user", "content": "ok"}]}
        )
    with pytest.raises(ValidationError):
        pixel.ChatStreamRequest.model_validate(
            {"chat_id": "safe", "messages": [{"role": "tool", "content": "ok"}]}
        )
    with pytest.raises(ValidationError):
        pixel.ChatCancelRequest.model_validate({"chat_id": "../../escape"})
    with pytest.raises(ValidationError):
        pixel.ChatCancelRequest.model_validate({"chat_id": "safe", "extra": True})


def test_request_aggregate_is_bounded_in_utf8_bytes():
    with pytest.raises(ValidationError):
        pixel.ChatStreamRequest.model_validate(
            {
                "chat_id": "safe",
                "messages": [{"role": "user", "content": "😀" * (16 * 1024)} for _ in range(5)],
            }
        )


def test_stream_timeout_budget_outlives_pixel_edge():
    assert pixel._CHAT_STREAM_TIMEOUT_SECONDS == 2040.0


def test_routes_require_dashboard_auth():
    app = FastAPI()
    app.include_router(pixel.router)
    client = TestClient(app)
    assert client.get("/api/pixel/status").status_code in {401, 403}
    assert client.post("/api/pixel/chat/stream", json={}).status_code in {401, 403}
    assert client.post("/api/pixel/chat/cancel", json={"chat_id": "safe"}).status_code in {401, 403}
    assert client.get(
        "/api/pixel/ops/ops-1788127319657-f3262c99a419",
        params={"plan_hash": "e" * 64},
    ).status_code in {401, 403}


@pytest.mark.asyncio
async def test_operations_status_returns_only_exact_host_projection(monkeypatch):
    job_id = "ops-1788127319657-f3262c99a419"
    plan_hash = "e" * 64
    secret = "protected-plan-argv-must-not-appear"

    async def exact_projection(method, path, **kwargs):
        assert method == "GET"
        assert path == "/v1/pixel/ops-status"
        assert kwargs["params"] == {"job_id": job_id, "plan_hash": plan_hash}
        return {
            "schemaVersion": 1,
            "kind": "ods-pixel-operations-status",
            "jobId": job_id,
            "planHash": plan_hash,
            "status": "awaiting-approval",
            "riskTier": "managed",
            "approvalRequired": True,
            "updatedAt": "2026-08-30T22:01:59Z",
            "approvalCommand": f"/opt/ods/bin/ods-pixel-approve {job_id} {plan_hash} --confirm",
        }

    monkeypatch.setattr(pixel, "request_agent_json", exact_projection)
    result = await pixel.pixel_operations_status(job_id, plan_hash)
    assert result["jobId"] == job_id
    assert result["planHash"] == plan_hash
    assert result["status"] == "awaiting-approval"
    assert secret not in json.dumps(result)


@pytest.mark.asyncio
async def test_operations_status_rejects_unbound_host_projection(monkeypatch):
    job_id = "ops-1788127319657-f3262c99a419"
    plan_hash = "e" * 64

    async def mismatched_projection(*_args, **_kwargs):
        return {
            "schemaVersion": 1,
            "kind": "ods-pixel-operations-status",
            "jobId": job_id,
            "planHash": "f" * 64,
            "status": "awaiting-approval",
            "riskTier": "managed",
            "approvalRequired": True,
            "updatedAt": "2026-08-30T22:01:59Z",
            "approvalCommand": "unsafe",
        }

    monkeypatch.setattr(pixel, "request_agent_json", mismatched_projection)
    with pytest.raises(HTTPException) as exc:
        await pixel.pixel_operations_status(job_id, plan_hash)
    assert exc.value.status_code == 502


@pytest.mark.asyncio
async def test_explicit_cancel_forwards_only_validated_chat_id_and_edge_key():
    calls = []
    body = pixel.ChatCancelRequest.model_validate({"chat_id": "conversation_1"})
    with patch.object(
        pixel.httpx,
        "AsyncClient",
        return_value=CancelAwareClient(FakeResponse(), calls),
    ):
        result = await pixel.pixel_chat_cancel(body)

    assert result == {"aborted": True}
    assert len(calls) == 1
    assert calls[0]["method"] == "POST"
    assert calls[0]["url"] == "http://pixel-edge:9595/v1/chat/cancel"
    assert calls[0]["json"] == {"user": "conversation_1"}
    assert calls[0]["headers"]["Authorization"] == f"Bearer {EDGE_KEY}"
    assert "dashboard-test-key" not in json.dumps(calls)


@pytest.mark.asyncio
async def test_explicit_cancel_reports_unconfirmed_without_inventing_success():
    body = pixel.ChatCancelRequest.model_validate({"chat_id": "conversation_1"})
    upstream = FakeResponse(content_type="application/json", chunks=[b'{"aborted":false}'])
    with patch.object(pixel.httpx, "AsyncClient", return_value=FakeClient(upstream)):
        assert await pixel.pixel_chat_cancel(body) == {"aborted": False}


@pytest.mark.asyncio
async def test_status_is_disabled_without_a_key(monkeypatch):
    monkeypatch.delenv("PIXEL_OPENWEBUI_KEY", raising=False)
    assert await pixel.pixel_status() == {
        "available": False,
        "model": None,
        "detail": "Pixel is not enabled",
    }


@pytest.mark.asyncio
async def test_status_returns_only_fixed_projection():
    secret = "upstream-secret-must-not-appear"
    body = json.dumps({"data": [{"id": "pixel/default", "owned_by": secret}]}).encode()
    response = FakeResponse(chunks=[body])
    with patch.object(pixel.httpx, "AsyncClient", return_value=FakeClient(response)):
        result = await pixel.pixel_status()
    assert result == {"available": True, "model": "pixel/default", "detail": "Owner agent ready"}
    assert secret not in json.dumps(result)


@pytest.mark.asyncio
async def test_status_projects_active_model_switch_without_touching_edge(monkeypatch):
    async def active_model_lifecycle(*_args, **_kwargs):
        return {
            "status": "idle",
            "lifecycleActive": True,
            "activeOperation": "model_activation",
            "activeTarget": "secret-model-name",
        }

    monkeypatch.setattr(pixel, "request_agent_json", active_model_lifecycle)
    with patch.object(
        pixel.httpx,
        "AsyncClient",
        side_effect=AssertionError("model switch readiness reached Pixel edge"),
    ):
        result = await pixel.pixel_status()

    assert result == {
        "available": False,
        "model": None,
        "state": "model_switching",
        "detail": pixel._MODEL_SWITCH_DETAIL,
    }
    assert "secret-model-name" not in json.dumps(result)


@pytest.mark.asyncio
async def test_lifecycle_probe_failure_does_not_falsely_disable_pixel(monkeypatch):
    async def failed_model_lifecycle(*_args, **_kwargs):
        raise pixel.AgentClientError("unreachable")

    monkeypatch.setattr(pixel, "request_agent_json", failed_model_lifecycle)
    assert await pixel._model_activation_in_progress() is False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "response",
    [
        FakeResponse(status=500, chunks=[b"secret"]),
        FakeResponse(content_type="text/plain", chunks=[b"secret"]),
        FakeResponse(chunks=[b"x" * (64 * 1024 + 1)]),
        FakeResponse(chunks=[b"not-json"]),
    ],
)
async def test_status_errors_are_bounded_and_sanitized(response):
    with patch.object(pixel.httpx, "AsyncClient", return_value=FakeClient(response)):
        result = await pixel.pixel_status()
    assert result["available"] is False
    assert "secret" not in json.dumps(result)
    assert "not-json" not in json.dumps(result)


@pytest.mark.asyncio
async def test_chat_forwards_exact_body_and_narrow_edge_key_only():
    capture = {}
    upstream = FakeResponse(
        content_type="text/event-stream; charset=utf-8",
        chunks=[b'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', b"data: [DONE]\n\n"],
    )
    body = pixel.ChatStreamRequest.model_validate(
        {"chat_id": "conversation_1", "messages": [{"role": "user", "content": "hello"}]}
    )
    with patch.object(pixel.httpx, "AsyncClient", return_value=FakeClient(upstream, capture)):
        response = await pixel.pixel_chat_stream(ConnectedRequest(), body)
        streamed = await stream_body(response)
    assert streamed.count(b"data: [DONE]") == 1
    assert capture["method"] == "POST"
    assert capture["url"] == "http://pixel-edge:9595/v1/chat/completions"
    assert capture["json"] == {
        "model": "pixel/default",
        "stream": True,
        "user": "conversation_1",
        "messages": [{"role": "user", "content": "hello"}],
    }
    assert capture["headers"]["Authorization"] == f"Bearer {EDGE_KEY}"
    assert "dashboard-test-key" not in json.dumps(capture)
    assert pixel_runtime_state._local_pixel_stream_active() is False


@pytest.mark.asyncio
async def test_chat_is_rejected_before_edge_during_model_activation(monkeypatch):
    async def active_model_lifecycle(*_args, **_kwargs):
        return {"lifecycleActive": True, "activeOperation": "model_activation"}

    monkeypatch.setattr(pixel, "request_agent_json", active_model_lifecycle)
    body = pixel.ChatStreamRequest.model_validate(
        {"chat_id": "c1", "messages": [{"role": "user", "content": "hello"}]}
    )
    with patch.object(
        pixel.httpx,
        "AsyncClient",
        side_effect=AssertionError("model switch turn reached Pixel edge"),
    ):
        with pytest.raises(HTTPException) as exc_info:
            await pixel.pixel_chat_stream(ConnectedRequest(), body)

    assert exc_info.value.status_code == 409
    assert exc_info.value.detail == pixel._MODEL_SWITCH_DETAIL


@pytest.mark.asyncio
async def test_accepted_chat_marks_runtime_active_until_stream_closes():
    upstream = FakeResponse(
        content_type="text/event-stream",
        chunks=[b"data: [DONE]\n\n"],
    )
    body = pixel.ChatStreamRequest.model_validate(
        {"chat_id": "c1", "messages": [{"role": "user", "content": "hello"}]}
    )
    with patch.object(pixel.httpx, "AsyncClient", return_value=FakeClient(upstream)):
        response = await pixel.pixel_chat_stream(ConnectedRequest(), body)
        assert pixel_stream_active() is True
        assert await stream_body(response) == b"data: [DONE]\n\n"
    assert pixel_runtime_state._local_pixel_stream_active() is False


def test_pixel_runtime_activity_accepts_only_exact_content_free_projection(monkeypatch):
    class ActivityResponse:
        status_code = 200
        headers = {"content-type": "application/json"}
        content = b'{"active":true,"streams":2}'

        def json(self):
            return {"active": True, "streams": 2}

    class ActivityClient:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def get(self, url, **kwargs):
            assert url == "http://pixel-edge:9595/v1/activity"
            assert kwargs["headers"]["Authorization"] == f"Bearer {EDGE_KEY}"
            return ActivityResponse()

    monkeypatch.setattr(pixel_runtime_state.httpx, "Client", lambda **_kwargs: ActivityClient())
    assert pixel_runtime_state._pixel_edge_stream_active() is True


def test_pixel_runtime_activity_fails_open_on_ambiguous_projection(monkeypatch):
    class ActivityResponse:
        status_code = 200
        headers = {"content-type": "application/json"}
        content = b'{"active":true,"streams":1,"chat":"secret"}'

        def json(self):
            return {"active": True, "streams": 1, "chat": "secret"}

    class ActivityClient:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def get(self, *_args, **_kwargs):
            return ActivityResponse()

    monkeypatch.setattr(pixel_runtime_state.httpx, "Client", lambda **_kwargs: ActivityClient())
    assert pixel_runtime_state._pixel_edge_stream_active() is False


@pytest.mark.asyncio
async def test_silent_upstream_is_cancelled_when_dashboard_client_disconnects():
    upstream = SilentResponse()
    calls = []
    body = pixel.ChatStreamRequest.model_validate(
        {"chat_id": "c1", "messages": [{"role": "user", "content": "hello"}]}
    )
    with patch.object(
        pixel.httpx,
        "AsyncClient",
        return_value=CancelAwareClient(upstream, calls),
    ):
        response = await pixel.pixel_chat_stream(DisconnectedRequest(), body)
        streamed = await asyncio.wait_for(stream_body(response), timeout=2)
    assert streamed == b""
    assert upstream.cancelled.is_set()
    assert [call["url"] for call in calls] == [
        "http://pixel-edge:9595/v1/chat/completions",
        "http://pixel-edge:9595/v1/chat/cancel",
    ]
    assert calls[1]["json"] == {"user": "c1"}
    assert calls[1]["headers"]["Authorization"] == f"Bearer {EDGE_KEY}"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "upstream",
    [
        FakeResponse(status=500, content_type="text/event-stream", chunks=[b"secret upstream body"]),
        FakeResponse(content_type="text/plain", chunks=[b"secret upstream body"]),
    ],
)
async def test_stream_rejections_never_reflect_upstream_body(upstream):
    body = pixel.ChatStreamRequest.model_validate(
        {"chat_id": "c1", "messages": [{"role": "user", "content": "hello"}]}
    )
    with patch.object(pixel.httpx, "AsyncClient", return_value=FakeClient(upstream)):
        with pytest.raises(HTTPException) as exc_info:
            await pixel.pixel_chat_stream(ConnectedRequest(), body)
    assert exc_info.value.status_code == 502
    assert "secret upstream body" not in str(exc_info.value.detail)


@pytest.mark.asyncio
async def test_stream_line_limit_fails_closed():
    upstream = FakeResponse(
        content_type="text/event-stream",
        chunks=[b"data: " + b"x" * (1024 * 1024 + 1)],
    )
    body = pixel.ChatStreamRequest.model_validate(
        {"chat_id": "c1", "messages": [{"role": "user", "content": "hello"}]}
    )
    with patch.object(pixel.httpx, "AsyncClient", return_value=FakeClient(upstream)):
        response = await pixel.pixel_chat_stream(ConnectedRequest(), body)
        streamed = await stream_body(response)
    assert b"safety limit" in streamed
    assert streamed.endswith(b"data: [DONE]\n\n")


@pytest.mark.asyncio
async def test_stream_handles_split_utf8_without_decoding_or_corruption():
    value = "hello 😀".encode("utf-8")
    upstream = FakeResponse(
        content_type="text/event-stream",
        chunks=[b"data: " + value[:8], value[8:] + b"\n\n", b"data: [DONE]\n\n"],
    )
    body = pixel.ChatStreamRequest.model_validate(
        {"chat_id": "c1", "messages": [{"role": "user", "content": "hello"}]}
    )
    with patch.object(pixel.httpx, "AsyncClient", return_value=FakeClient(upstream)):
        response = await pixel.pixel_chat_stream(ConnectedRequest(), body)
        streamed = await stream_body(response)
    assert value in streamed
    assert streamed.count(b"data: [DONE]") == 1
