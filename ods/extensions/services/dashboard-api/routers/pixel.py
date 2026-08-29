"""Bounded dashboard bridge to the internal Pixel edge service."""

from __future__ import annotations

import asyncio
import json
import os
import re
from typing import AsyncIterator
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

from security import verify_api_key


_DEFAULT_EDGE_URL = "http://pixel-edge:9595"
_MODEL = "pixel/default"
_CHAT_STREAM_TIMEOUT_SECONDS = 2040.0
_CLIENT_DISCONNECT_POLL_SECONDS = 0.25
_CLIENT_CANCEL_TIMEOUT_SECONDS = 7.0
_MAX_KEY_LENGTH = 4096
_MAX_STATUS_BYTES = 64 * 1024
_MAX_SSE_LINE_BYTES = 1024 * 1024
_MAX_MESSAGE_CHARS = 16 * 1024
_MAX_TOTAL_MESSAGE_BYTES = 256 * 1024
_SAFE_CHAT_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")


def _validate_edge_url(raw: str) -> str:
    """Accept exactly the fixed internal Pixel edge origin."""
    try:
        parsed = urlparse(raw)
        port = parsed.port
    except (TypeError, ValueError) as exc:
        raise ValueError("PIXEL_EDGE_URL is invalid") from exc
    if parsed.scheme != "http":
        raise ValueError("PIXEL_EDGE_URL scheme must be http")
    if parsed.hostname != "pixel-edge" or port != 9595:
        raise ValueError("PIXEL_EDGE_URL must use pixel-edge:9595")
    if parsed.username or parsed.password or parsed.path or parsed.params or parsed.query or parsed.fragment:
        raise ValueError("PIXEL_EDGE_URL must be an origin without userinfo, path, query, or fragment")
    return _DEFAULT_EDGE_URL


def _pixel_config() -> tuple[str, str] | None:
    """Return validated runtime config, or None when Pixel is not enabled."""
    raw_key = os.environ.get("PIXEL_OPENWEBUI_KEY", "")
    if not raw_key:
        return None
    if raw_key != raw_key.strip() or len(raw_key) < 32 or len(raw_key) > _MAX_KEY_LENGTH:
        raise RuntimeError("PIXEL_OPENWEBUI_KEY is invalid")
    if _CONTROL.search(raw_key):
        raise RuntimeError("PIXEL_OPENWEBUI_KEY is invalid")
    raw_url = os.environ.get("PIXEL_EDGE_URL", _DEFAULT_EDGE_URL)
    return _validate_edge_url(raw_url), raw_key


def _edge_headers(key: str, *, accept: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {key}",
        "Accept": accept,
        "Content-Type": "application/json",
    }


class _Message(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    role: str
    content: str = Field(max_length=_MAX_MESSAGE_CHARS)

    @field_validator("role")
    @classmethod
    def _role(cls, value: str) -> str:
        if value not in {"system", "user", "assistant"}:
            raise ValueError("unsupported message role")
        return value


class ChatStreamRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    chat_id: str
    messages: list[_Message] = Field(min_length=1, max_length=50)

    @field_validator("chat_id")
    @classmethod
    def _chat_id(cls, value: str) -> str:
        if not _SAFE_CHAT_ID.fullmatch(value):
            raise ValueError("invalid chat_id")
        return value

    @field_validator("messages")
    @classmethod
    def _total_size(cls, messages: list[_Message]) -> list[_Message]:
        total = sum(len(item.content.encode("utf-8")) for item in messages)
        if total > _MAX_TOTAL_MESSAGE_BYTES:
            raise ValueError("aggregate message content is too large")
        return messages


router = APIRouter(prefix="/api/pixel", tags=["pixel"])


async def _bounded_response_bytes(response: httpx.Response, limit: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    async for chunk in response.aiter_bytes():
        total += len(chunk)
        if total > limit:
            raise ValueError("response too large")
        chunks.append(chunk)
    return b"".join(chunks)


@router.get("/status", dependencies=[Depends(verify_api_key)])
async def pixel_status() -> dict[str, object]:
    """Return a fixed, nonsecret Pixel availability projection."""
    config = _pixel_config()
    if config is None:
        return {"available": False, "model": None, "detail": "Pixel is not enabled"}
    edge_url, key = config
    try:
        timeout = httpx.Timeout(connect=5.0, read=5.0, write=5.0, pool=5.0)
        async with httpx.AsyncClient(timeout=timeout, trust_env=False, follow_redirects=False) as client:
            async with client.stream(
                "GET",
                f"{edge_url}/v1/models",
                headers=_edge_headers(key, accept="application/json"),
            ) as response:
                if response.status_code != 200:
                    return {"available": False, "model": None, "detail": "Pixel edge is unavailable"}
                if not response.headers.get("content-type", "").lower().startswith("application/json"):
                    return {"available": False, "model": None, "detail": "Pixel edge returned an invalid response"}
                raw = await _bounded_response_bytes(response, _MAX_STATUS_BYTES)
        payload = json.loads(raw)
        models = payload.get("data") if isinstance(payload, dict) else None
        available = isinstance(models, list) and any(
            isinstance(item, dict) and item.get("id") == _MODEL for item in models
        )
        return {
            "available": available,
            "model": _MODEL if available else None,
            "detail": "Owner agent ready" if available else "pixel/default is unavailable",
        }
    except (httpx.HTTPError, asyncio.TimeoutError):
        return {"available": False, "model": None, "detail": "Pixel edge is unavailable"}
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError, TypeError):
        return {"available": False, "model": None, "detail": "Pixel edge returned an invalid response"}


def _error_event(message: str) -> bytes:
    payload = {"error": {"message": message, "type": "pixel_dashboard_error"}}
    return f"data: {json.dumps(payload)}\n\n".encode()


async def _cancel_edge_run(edge_url: str, key: str, chat_id: str) -> bool:
    """Best-effort cancellation over the fixed authenticated internal edge."""
    timeout = httpx.Timeout(connect=2.0, read=5.0, write=2.0, pool=2.0)
    try:
        async with httpx.AsyncClient(
            timeout=timeout,
            trust_env=False,
            follow_redirects=False,
        ) as client:
            async with client.stream(
                "POST",
                f"{edge_url}/v1/chat/cancel",
                json={"user": chat_id},
                headers=_edge_headers(key, accept="application/json"),
            ) as response:
                if response.status_code != 200:
                    return False
                if not response.headers.get("content-type", "").lower().startswith(
                    "application/json"
                ):
                    return False
                raw = await _bounded_response_bytes(response, 1024)
        parsed = json.loads(raw)
        return (
            isinstance(parsed, dict)
            and set(parsed) == {"aborted"}
            and parsed.get("aborted") is True
        )
    except (
        httpx.HTTPError,
        asyncio.TimeoutError,
        json.JSONDecodeError,
        UnicodeDecodeError,
        ValueError,
        TypeError,
    ):
        return False


class _ClientDisconnected(Exception):
    """The dashboard consumer left while Pixel was still producing a turn."""


async def _iter_upstream_chunks(
    upstream: httpx.Response,
    request: Request,
) -> AsyncIterator[bytes]:
    """Yield upstream bytes while promptly observing a silent client exit."""
    iterator = upstream.aiter_bytes().__aiter__()
    pending: asyncio.Task[bytes] | None = None
    try:
        while True:
            pending = asyncio.create_task(anext(iterator))
            while not pending.done():
                done, _ = await asyncio.wait(
                    {pending},
                    timeout=_CLIENT_DISCONNECT_POLL_SECONDS,
                )
                if done:
                    break
                if await request.is_disconnected():
                    raise _ClientDisconnected
            try:
                chunk = pending.result()
            except StopAsyncIteration:
                return
            pending = None
            yield chunk
    finally:
        if pending is not None and not pending.done():
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
        close = getattr(iterator, "aclose", None)
        if callable(close):
            await close()


@router.post("/chat/stream", dependencies=[Depends(verify_api_key)])
async def pixel_chat_stream(request: Request, body: ChatStreamRequest) -> StreamingResponse:
    """Forward one bounded chat over authenticated, unbuffered SSE."""
    config = _pixel_config()
    if config is None:
        raise HTTPException(status_code=503, detail="Pixel is not enabled")
    edge_url, key = config
    edge_body = {
        "model": _MODEL,
        "stream": True,
        "user": body.chat_id,
        "messages": [message.model_dump() for message in body.messages],
    }

    # Pixel Edge is capped at 33 minutes; retain one bounded minute of outer
    # headroom so this bridge never aborts a valid CPU-only first turn first.
    timeout = httpx.Timeout(
        connect=5.0,
        read=_CHAT_STREAM_TIMEOUT_SECONDS,
        write=30.0,
        pool=5.0,
    )
    client = httpx.AsyncClient(timeout=timeout, trust_env=False, follow_redirects=False)
    upstream_context = client.stream(
        "POST",
        f"{edge_url}/v1/chat/completions",
        json=edge_body,
        headers=_edge_headers(key, accept="text/event-stream"),
    )
    try:
        upstream = await upstream_context.__aenter__()
    except (httpx.HTTPError, asyncio.TimeoutError) as exc:
        await client.aclose()
        raise HTTPException(status_code=503, detail="Pixel stream is unavailable") from exc
    if upstream.status_code != 200:
        await upstream_context.__aexit__(None, None, None)
        await client.aclose()
        raise HTTPException(status_code=502, detail="Pixel request was rejected")
    if not upstream.headers.get("content-type", "").lower().startswith("text/event-stream"):
        await upstream_context.__aexit__(None, None, None)
        await client.aclose()
        raise HTTPException(status_code=502, detail="Pixel returned an invalid stream")

    async def stream() -> AsyncIterator[bytes]:
        done_seen = False
        try:
            async with asyncio.timeout(_CHAT_STREAM_TIMEOUT_SECONDS):
                buffered = bytearray()
                async for chunk in _iter_upstream_chunks(upstream, request):
                    buffered.extend(chunk)
                    while True:
                        newline = buffered.find(b"\n")
                        if newline < 0:
                            break
                        line = bytes(buffered[: newline + 1])
                        del buffered[: newline + 1]
                        if len(line.rstrip(b"\r\n")) > _MAX_SSE_LINE_BYTES:
                            yield _error_event("Pixel stream exceeded its safety limit")
                            yield b"data: [DONE]\n\n"
                            return
                        yield line
                        if line.rstrip(b"\r\n") == b"data: [DONE]":
                            done_seen = True
                    if len(buffered) > _MAX_SSE_LINE_BYTES:
                        yield _error_event("Pixel stream exceeded its safety limit")
                        yield b"data: [DONE]\n\n"
                        return
                if buffered:
                    yield bytes(buffered)
        except _ClientDisconnected:
            return
        except (GeneratorExit, asyncio.CancelledError):
            raise
        except (httpx.HTTPError, asyncio.TimeoutError):
            yield _error_event("Pixel stream is unavailable")
        except Exception:
            yield _error_event("Pixel stream failed")
        finally:
            if not done_seen:
                cancel_task = asyncio.create_task(_cancel_edge_run(edge_url, key, body.chat_id))
                try:
                    await asyncio.wait_for(
                        asyncio.shield(cancel_task),
                        timeout=_CLIENT_CANCEL_TIMEOUT_SECONDS,
                    )
                except (asyncio.CancelledError, asyncio.TimeoutError):
                    pass
            await upstream_context.__aexit__(None, None, None)
            await client.aclose()
        if not done_seen:
            yield b"data: [DONE]\n\n"

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-store",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
