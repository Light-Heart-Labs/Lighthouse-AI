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
