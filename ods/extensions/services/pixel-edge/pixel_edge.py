"""Pixel Edge — internal OpenAI-compatible proxy.

Routes:
  GET  /health                — unauthenticated liveness
  GET  /v1/models             — bearer-auth, synthetic listing only
  POST /v1/chat/completions   — bearer-auth, model rewrite, SSE passthrough

All other paths/methods return 404 (catch-all).
"""

import asyncio
import hmac
import ipaddress
import json
import os
import re
import sys
import time
from urllib.parse import urlsplit

from aiohttp import web, ClientSession, UnixConnector, ClientTimeout

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_BEARER_TOKEN = os.environ.get("PIXEL_OPENWEBUI_KEY", "")
_SOCKET_PATH = os.environ.get("PIXEL_INGRESS_SOCKET", "/pixel-runtime/pixel-ingress.sock")
_ALLOWED_MODELS = ("pixel/default",)
_LISTEN_PORT = int(os.environ.get("PIXEL_EDGE_PORT_INTERNAL", "9595"))

# Header names (case-insensitive) that may be forwarded to upstream.
_SAFE_HEADERS = frozenset({
    "accept",
    "user-agent",
})

# Hop-by-hop headers per RFC 7230.
_HOP_BY_HOP = frozenset({
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
})

_MAX_BODY = 2 * 1024 * 1024          # 2 MiB request body
_MAX_CANCEL_BODY = 256
_MAX_RESPONSE_BYTES = 2 * 1024 * 1024  # 2 MiB non-stream response cap
_MAX_CANCEL_RESPONSE_BYTES = 1024

_CONNECT_TIMEOUT = 5
# The host ingress is capped at 32 minutes. Pixel Edge sits outside that
# trusted boundary, so both its total and no-first-byte budgets allow one
# additional minute before failing closed.
_TOTAL_TIMEOUT = 1980
_SOCK_READ_TIMEOUT = 1980
_MAX_SSE_LINE = 1024 * 1024

_UPSTREAM_REWRITE = "openclaw/default"
_PIXEL_REWRITE = "pixel/default"
_SAFE_CHAT_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_HTTP_URL = re.compile(r"https?://[^\s<>{}\[\]\"']+", re.IGNORECASE)
_PRIVATE_URL_INTENT = re.compile(
    r"\b(?:access|browse|call|check|connect|download|fetch|inspect|open|query|read|"
    r"request|retrieve|summari[sz]e|test|visit)\b|"
    r"\btell\s+me\b|\bwhat(?:\s+is|'s)\s+(?:at|on)\b",
    re.IGNORECASE,
)
_ARTIFACT_DRAFT_PREFIX = re.compile(
    r"^\s*(?:please\s+)?(?:write|draft|document|compose|create|edit|update|"
    r"refactor|implement|generate)\b",
    re.IGNORECASE,
)
_ARTIFACT_NOUN = re.compile(
    r"\b(?:code|config(?:uration)?|documentation|example|file|fixture|readme|"
    r"script|snippet|test)\b",
    re.IGNORECASE,
)
_FOLLOWUP_PRIVATE_ACCESS = re.compile(
    r"\b(?:and\s+)?then\s+(?:access|browse|call|check|connect|download|fetch|"
    r"inspect|open|query|read|request|retrieve|summari[sz]e|test|visit)\b",
    re.IGNORECASE,
)
_PRIVATE_HOST_SUFFIXES = (".localhost", ".local", ".internal")
_PRIVATE_URL_REPLY = (
    "I couldn't access that private page from this chat, so I can't verify its "
    "title or contents. If you paste the page text or HTML here, I can inspect "
    "it; otherwise, use a separately approved private-network or browser capability."
)
_RESERVED_ASSISTANT_REPLIES = frozenset({
    "NO_REPLY",
    "No response from OpenClaw.",
})
_SHORT_TEST_MESSAGE = re.compile(
    r"^\s*(?:(?:just\s+)?test(?:ing)?(?:\s+[\w.-]+){0,4}|ping|hello|hi|hey)"
    r"\s*[.!?]*\s*$",
    re.IGNORECASE,
)
_SHORT_TEST_REPLY = (
    "Pixel is online and responding. What would you like me to help with?"
)
_EMPTY_REPLY = (
    "I couldn't produce a useful response to that request. Please try again or "
    "tell me what you'd like me to do differently."
)
_CANCEL_EVENTS_KEY = web.AppKey("pixel_cancel_events", dict)


def _validate_config() -> str:
    """Return the raw bearer token after validating it is well-formed.

    Exits with a non-zero code if the token is missing/blank/oversized.
    """
    if not _BEARER_TOKEN or _BEARER_TOKEN != _BEARER_TOKEN.strip():
        print("FATAL: PIXEL_OPENWEBUI_KEY is not set or blank", file=sys.stderr)
        sys.exit(1)
    if len(_BEARER_TOKEN) < 32 or len(_BEARER_TOKEN) > 4096 or any(ord(ch) < 33 for ch in _BEARER_TOKEN):
        print("FATAL: PIXEL_OPENWEBUI_KEY has an invalid length or character", file=sys.stderr)
        sys.exit(1)
    return _BEARER_TOKEN


config_token = _validate_config()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _constant_time_compare(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode("utf-8", "replace"),
                               b.encode("utf-8", "replace"))


def _check_auth(request: web.Request):
    """Return a 401 Response on failure, or None on success."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return web.json_response({"error": "unauthorized"}, status=401)
    token = auth[len("Bearer "):]
    if not _constant_time_compare(token, config_token):
        return web.json_response({"error": "unauthorized"}, status=401)
    return None


def _sanitize_headers(headers: dict) -> dict:
    """Strip blocked/hop-by-hop headers and anything not on the safe list."""
    out = {}
    for name, value in headers.items():
        low = name.lower()
        if low.startswith("x-openclaw-") or low in _HOP_BY_HOP or low not in _SAFE_HEADERS:
            continue
        out[name] = value
    return out


def _rewrite_json_model(raw: bytes) -> bytes:
    """Rewrite exact JSON ``model`` fields without altering assistant text."""
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return raw

    def _walk(obj):
        if isinstance(obj, list):
            return [_walk(v) for v in obj]
        if isinstance(obj, dict):
            return {
                k: (_PIXEL_REWRITE if k == "model" and v == _UPSTREAM_REWRITE else _walk(v))
                for k, v in obj.items()
            }
        return obj

    return json.dumps(_walk(parsed)).encode("utf-8")


def _latest_user_text(data: dict) -> str:
    messages = data.get("messages")
    if not isinstance(messages, list):
        return ""
    for message in reversed(messages):
        if isinstance(message, dict) and message.get("role") == "user":
            return _message_text(message.get("content")).strip()
    return ""


def _empty_reply_fallback(data: dict) -> str:
    text = _latest_user_text(data)
    if len(text) <= 160 and _SHORT_TEST_MESSAGE.fullmatch(text):
        return _SHORT_TEST_REPLY
    return _EMPTY_REPLY


def _reserved_reply(value) -> bool:
    return isinstance(value, str) and (
        not value.strip() or value.strip() in _RESERVED_ASSISTANT_REPLIES
    )


def _rewrite_json_response(raw: bytes, fallback: str) -> bytes:
    """Rewrite model identity and replace only an exact reserved/empty final reply."""
    try:
        parsed = json.loads(_rewrite_json_model(raw))
    except (json.JSONDecodeError, ValueError):
        return raw
    choices = parsed.get("choices") if isinstance(parsed, dict) else None
    if isinstance(choices, list):
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            message = choice.get("message")
            if isinstance(message, dict) and _reserved_reply(message.get("content")):
                message["content"] = fallback
    return json.dumps(parsed).encode("utf-8")


def _sse_event(line: bytes):
    if not line.startswith(b"data: ") or line == b"data: [DONE]":
        return None, None, None
    try:
        event = json.loads(line[6:])
    except (json.JSONDecodeError, ValueError, UnicodeDecodeError):
        return None, None, None
    choices = event.get("choices") if isinstance(event, dict) else None
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return event, None, None
    choice = choices[0]
    delta = choice.get("delta")
    content = delta.get("content") if isinstance(delta, dict) else None
    return event, content if isinstance(content, str) else None, choice.get("finish_reason")


def _fallback_sse_line(template: dict, fallback: str, *, finished: bool) -> bytes:
    event = {
        key: template[key]
        for key in ("id", "object", "created", "model")
        if key in template
    }
    event["choices"] = [{
        "index": 0,
        "delta": {} if finished else {"content": fallback},
        "finish_reason": "stop" if finished else None,
    }]
    return b"data: " + json.dumps(event).encode("utf-8")


async def _read_bounded(content, limit: int) -> bytes:
    chunks = []
    total = 0
    async for chunk in content.iter_any():
        total += len(chunk)
        if total > limit:
            raise ValueError("response too large")
        chunks.append(chunk)
    return b"".join(chunks)


def _message_text(content) -> str:
    """Extract text from one OpenAI-compatible message content value."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for part in content:
        if not isinstance(part, dict):
            continue
        value = part.get("text")
        if not isinstance(value, str):
            value = part.get("content")
        if isinstance(value, str):
            parts.append(value)
    return "\n".join(parts)


def _is_private_http_url(value: str) -> bool:
    """Return true for HTTP(S) URLs outside the public-DNS-only boundary."""
    try:
        parsed = urlsplit(value.rstrip(".,;:!?)]}"))
        hostname = (parsed.hostname or "").rstrip(".").lower()
    except (ValueError, UnicodeError):
        return False
    if parsed.scheme.lower() not in {"http", "https"} or not hostname:
        return False
    try:
        ipaddress.ip_address(hostname)
        return True
    except ValueError:
        pass
    return (
        hostname == "localhost"
        or "." not in hostname
        or hostname.endswith(_PRIVATE_HOST_SUFFIXES)
    )


def _private_url_access_requested(data: dict) -> bool:
    """Detect an explicit request to access a private URL in the latest user turn."""
    messages = data.get("messages")
    if not isinstance(messages, list):
        return False
    for message in reversed(messages):
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        text = _message_text(message.get("content"))
        if not _PRIVATE_URL_INTENT.search(text):
            return False
        if not any(_is_private_http_url(match.group(0)) for match in _HTTP_URL.finditer(text)):
            return False
        # A coding request can legitimately contain a private development URL
        # as inert source text. The downstream plugin still blocks any actual
        # shell/web contact, so keep drafting available unless the owner adds a
        # distinct follow-up instruction to access the target now.
        if (
            _ARTIFACT_DRAFT_PREFIX.search(text)
            and _ARTIFACT_NOUN.search(text)
            and not _FOLLOWUP_PRIVATE_ACCESS.search(text)
        ):
            return False
        return True
    return False


async def _private_url_response(request: web.Request, stream: bool):
    """Return the exact local boundary response without invoking Pixel upstream."""
    created = int(time.time())
    response_id = "chatcmpl-pixel-private-url"
    if not stream:
        return web.json_response({
            "id": response_id,
            "object": "chat.completion",
            "created": created,
            "model": _PIXEL_REWRITE,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": _PRIVATE_URL_REPLY},
                "finish_reason": "stop",
            }],
        })

    response = web.StreamResponse(
        status=200,
        headers={"Content-Type": "text/event-stream", "Cache-Control": "no-cache"},
    )
    await response.prepare(request)
    chunks = [
        {
            "id": response_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": _PIXEL_REWRITE,
            "choices": [{
                "index": 0,
                "delta": {"role": "assistant", "content": _PRIVATE_URL_REPLY},
                "finish_reason": None,
            }],
        },
        {
            "id": response_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": _PIXEL_REWRITE,
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
        },
    ]
    for chunk in chunks:
        await response.write(f"data: {json.dumps(chunk)}\n\n".encode("utf-8"))
    await response.write(b"data: [DONE]\n\n")
    await response.write_eof()
    return response


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

async def _ingress_ready() -> bool:
    connector = UnixConnector(path=_SOCKET_PATH)
    timeout = ClientTimeout(total=3, sock_connect=2, sock_read=2)
    try:
        async with ClientSession(connector=connector, timeout=timeout) as session:
            async with session.get("http://pixel-upstream/health") as resp:
                if resp.status != 200:
                    raise ConnectionError("ingress not ready")
                body = await resp.json(content_type=None)
                if body != {"status": "ok"}:
                    raise ConnectionError("ingress not ready")
    except Exception:
        return False
    return True


async def handle_health(_request: web.Request):
    """Report ready only when the private host ingress and gateway are ready."""
    if not await _ingress_ready():
        return web.json_response({"status": "unavailable"}, status=503)
    return web.json_response({"status": "ok"})


async def handle_models(request: web.Request):
    fail = _check_auth(request)
    # aiohttp Response objects may be falsey, including an intentional 401.
    # Check the sentinel explicitly or an unauthenticated request can fall
    # through to the protected handler.
    if fail is not None:
        return fail
    if not await _ingress_ready():
        return web.json_response({"error": "service unavailable"}, status=503)

    data = [{"id": m, "object": "model", "owned_by": "pixel"} for m in _ALLOWED_MODELS]
    return web.json_response({"object": "list", "data": data})


async def handle_chat_completions(request: web.Request):
    fail = _check_auth(request)
    if fail is not None:
        return fail

    if request.content_type != "application/json":
        return web.json_response({"error": "Content-Type must be application/json"},
                                 status=415)

    if request.content_length and request.content_length > _MAX_BODY:
        return web.json_response({"error": "request too large"}, status=413)

    try:
        body = await request.read()
    except Exception:
        return web.json_response({"error": "bad request"}, status=400)

    if len(body) > _MAX_BODY:
        return web.json_response({"error": "request too large"}, status=413)

    try:
        data = json.loads(body)
    except (json.JSONDecodeError, ValueError):
        return web.json_response({"error": "invalid JSON"}, status=400)

    if not isinstance(data, dict):
        return web.json_response({"error": "JSON object required"}, status=400)

    req_model = data.get("model", "")
    if req_model not in _ALLOWED_MODELS:
        return web.json_response({"error": "model not allowed"}, status=400)
    if _private_url_access_requested(data):
        return await _private_url_response(request, data.get("stream") is True)
    empty_reply_fallback = _empty_reply_fallback(data)
    chat_id = data.get("user")
    cancel_event = None
    if isinstance(chat_id, str) and _SAFE_CHAT_ID.fullmatch(chat_id):
        cancel_event = asyncio.Event()
        request.app[_CANCEL_EVENTS_KEY].setdefault(chat_id, set()).add(cancel_event)
    data["model"] = _UPSTREAM_REWRITE

    fwd_headers = _sanitize_headers(dict(request.headers))
    fwd_headers["Content-Type"] = "application/json"

    connector = UnixConnector(path=_SOCKET_PATH)
    timeout = ClientTimeout(total=_TOTAL_TIMEOUT,
                            sock_connect=_CONNECT_TIMEOUT,
                            sock_read=_SOCK_READ_TIMEOUT)

    try:
        async with ClientSession(connector=connector, timeout=timeout) as session:
            async with session.post("http://pixel-upstream/v1/chat/completions",
                                    json=data, headers=fwd_headers) as resp:
                ctype = resp.headers.get("Content-Type", "").lower()

                if resp.status >= 400:
                    status = 400 if 400 <= resp.status < 500 else 502
                    return web.json_response({"error": "pixel request rejected"}, status=status)

                if "text/event-stream" in ctype:
                    return await _stream_upstream(
                        request, resp, empty_reply_fallback, cancel_event
                    )

                if "application/json" not in ctype:
                    return web.json_response({"error": "invalid upstream response"}, status=502)

                # Non-streaming: cap bytes, then rewrite model identifiers.
                resp_body = bytearray()
                async for chunk in resp.content.iter_any():
                    resp_body.extend(chunk)
                    if len(resp_body) > _MAX_RESPONSE_BYTES:
                        return web.json_response({"error": "upstream response too large"},
                                                 status=502)

                rewritten = _rewrite_json_response(bytes(resp_body), empty_reply_fallback)
                return web.Response(status=resp.status, body=rewritten,
                                    content_type="application/json")
    except (ConnectionError, OSError, asyncio.TimeoutError):
        return web.json_response({"error": "service unavailable"}, status=502)
    except Exception:
        return web.json_response({"error": "bad gateway"}, status=502)
    finally:
        if cancel_event is not None:
            active = request.app[_CANCEL_EVENTS_KEY].get(chat_id)
            if active is not None:
                active.discard(cancel_event)
                if not active:
                    request.app[_CANCEL_EVENTS_KEY].pop(chat_id, None)


async def handle_chat_cancel(request: web.Request):
    """Relay one authenticated, bounded cancellation to the private ingress."""
    fail = _check_auth(request)
    if fail is not None:
        return fail
    if request.content_type != "application/json":
        return web.json_response({"error": "Content-Type must be application/json"},
                                 status=415)
    if request.content_length and request.content_length > _MAX_CANCEL_BODY:
        return web.json_response({"error": "request too large"}, status=413)

    try:
        raw = await request.read()
    except Exception:
        return web.json_response({"error": "bad request"}, status=400)
    if len(raw) > _MAX_CANCEL_BODY:
        return web.json_response({"error": "request too large"}, status=413)
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return web.json_response({"error": "invalid JSON"}, status=400)
    if (
        not isinstance(data, dict)
        or set(data) != {"user"}
        or not isinstance(data.get("user"), str)
        or not _SAFE_CHAT_ID.fullmatch(data["user"])
    ):
        return web.json_response({"error": "invalid cancellation request"}, status=400)

    connector = UnixConnector(path=_SOCKET_PATH)
    timeout = ClientTimeout(total=6, sock_connect=2, sock_read=5)
    try:
        async with ClientSession(connector=connector, timeout=timeout) as session:
            async with session.post(
                "http://pixel-upstream/v1/chat/cancel",
                json={"user": data["user"]},
                headers={"Content-Type": "application/json", "Accept": "application/json"},
            ) as resp:
                if resp.status != 200:
                    return web.json_response({"error": "pixel cancellation failed"}, status=502)
                if "application/json" not in resp.headers.get("Content-Type", "").lower():
                    return web.json_response({"error": "pixel cancellation failed"}, status=502)
                raw_result = await _read_bounded(resp.content, _MAX_CANCEL_RESPONSE_BYTES)
                result = json.loads(raw_result)
                if (
                    not isinstance(result, dict)
                    or set(result) != {"aborted"}
                    or not isinstance(result.get("aborted"), bool)
                ):
                    return web.json_response({"error": "pixel cancellation failed"}, status=502)
                if result["aborted"]:
                    active = request.app[_CANCEL_EVENTS_KEY].get(data["user"], ())
                    for event in tuple(active):
                        event.set()
                return web.json_response({"aborted": result["aborted"]})
    except (ConnectionError, OSError, asyncio.TimeoutError, json.JSONDecodeError, ValueError):
        return web.json_response({"error": "pixel cancellation failed"}, status=502)
    except Exception:
        return web.json_response({"error": "pixel cancellation failed"}, status=502)


async def _stream_upstream(
    request: web.Request,
    resp,
    empty_reply_fallback: str,
    cancel_event: asyncio.Event | None = None,
):
    """Stream bounded SSE while replacing only a reserved/empty final reply."""
    response = web.StreamResponse(
        status=resp.status,
        headers={"Content-Type": "text/event-stream", "Cache-Control": "no-cache"},
    )
    await response.prepare(request)
    buffered = bytearray()
    pending = []
    pending_text = ""
    passthrough = False

    async def flush_pending():
        nonlocal pending
        for item in pending:
            await response.write(item[0] + b"\n")
        pending = []

    async def replace_pending(template: dict, *, synthesize_finish: bool):
        nonlocal pending
        # Preserve role/metadata events, but never expose the reserved text.
        for line, _event, content, finish_reason in pending:
            if content is None and finish_reason is None:
                await response.write(line + b"\n")
        await response.write(
            _fallback_sse_line(template, empty_reply_fallback, finished=False) + b"\n"
        )
        if synthesize_finish:
            await response.write(
                _fallback_sse_line(template, empty_reply_fallback, finished=True) + b"\n"
            )
        pending = []

    try:
        async for chunk in resp.content.iter_any():
            buffered.extend(chunk)
            if len(buffered) > _MAX_SSE_LINE and b"\n" not in buffered:
                raise ValueError("SSE line exceeded limit")
            while b"\n" in buffered:
                line, _, remainder = buffered.partition(b"\n")
                buffered = bytearray(remainder)
                if cancel_event is not None and cancel_event.is_set():
                    pending = []
                    await response.write(b"data: [DONE]\n\n")
                    passthrough = True
                    await response.write_eof()
                    return response
                if len(line) > _MAX_SSE_LINE:
                    raise ValueError("SSE line exceeded limit")
                if line.startswith(b"data: ") and line != b"data: [DONE]":
                    line = b"data: " + _rewrite_json_model(line[6:])
                if passthrough:
                    await response.write(line + b"\n")
                    continue

                if line == b"data: [DONE]":
                    normalized = pending_text.strip()
                    if not normalized or normalized in _RESERVED_ASSISTANT_REPLIES:
                        template = next(
                            (item[1] for item in reversed(pending) if isinstance(item[1], dict)),
                            {"model": _PIXEL_REWRITE},
                        )
                        await replace_pending(template, synthesize_finish=True)
                    else:
                        await flush_pending()
                    await response.write(line + b"\n")
                    passthrough = True
                    continue

                event, content, finish_reason = _sse_event(line)
                if isinstance(event, dict) and "error" in event:
                    await flush_pending()
                    await response.write(line + b"\n")
                    passthrough = True
                    continue
                if finish_reason is not None:
                    normalized = pending_text.strip()
                    if not normalized or normalized in _RESERVED_ASSISTANT_REPLIES:
                        template = event if isinstance(event, dict) else next(
                            (item[1] for item in reversed(pending) if isinstance(item[1], dict)),
                            {"model": _PIXEL_REWRITE},
                        )
                        await replace_pending(template, synthesize_finish=False)
                    else:
                        await flush_pending()
                    await response.write(line + b"\n")
                    passthrough = True
                    continue

                pending.append((line, event, content, finish_reason))
                if content is not None:
                    pending_text += content
                    normalized = pending_text.strip()
                    if normalized and not any(
                        reserved.startswith(normalized)
                        for reserved in _RESERVED_ASSISTANT_REPLIES
                    ):
                        await flush_pending()
                        passthrough = True
        if cancel_event is not None and cancel_event.is_set():
            pending = []
            await response.write(b"data: [DONE]\n\n")
            await response.write_eof()
            return response
        if buffered:
            if len(buffered) > _MAX_SSE_LINE:
                raise ValueError("SSE line exceeded limit")
            line = bytes(buffered)
            if line.startswith(b"data: ") and line != b"data: [DONE]":
                line = b"data: " + _rewrite_json_model(line[6:])
            if passthrough:
                await response.write(line)
            else:
                event, content, finish_reason = _sse_event(line)
                pending.append((line, event, content, finish_reason))
        if not passthrough and pending:
            normalized = pending_text.strip()
            if not normalized or normalized in _RESERVED_ASSISTANT_REPLIES:
                template = next(
                    (item[1] for item in reversed(pending) if isinstance(item[1], dict)),
                    {"model": _PIXEL_REWRITE},
                )
                await replace_pending(template, synthesize_finish=False)
            else:
                await flush_pending()
    except (ConnectionError, OSError, asyncio.TimeoutError):
        if cancel_event is not None and cancel_event.is_set():
            await response.write(b"data: [DONE]\n\n")
        else:
            await response.write(b'data: {"error":"upstream error"}\n\ndata: [DONE]\n\n')
    except Exception:
        if cancel_event is not None and cancel_event.is_set():
            await response.write(b"data: [DONE]\n\n")
        else:
            await response.write(b'data: {"error":"upstream error"}\n\ndata: [DONE]\n\n')
    await response.write_eof()
    return response


async def handle_not_found(_request: web.Request):
    return web.json_response({"error": "not found"}, status=404)


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------

def create_app() -> web.Application:
    app = web.Application()
    app[_CANCEL_EVENTS_KEY] = {}
    app.router.add_get("/health", handle_health)
    app.router.add_get("/v1/models", handle_models)
    app.router.add_post("/v1/chat/completions", handle_chat_completions)
    app.router.add_post("/v1/chat/cancel", handle_chat_cancel)
    # Catch-all registered last: unmatched paths AND unmatched methods → 404.
    app.router.add_route("*", "/{tail:.*}", handle_not_found)
    return app


if __name__ == "__main__":
    web.run_app(create_app(), host="0.0.0.0", port=_LISTEN_PORT)
