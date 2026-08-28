"""Pixel Edge — internal OpenAI-compatible proxy.

Routes:
  GET  /health                — unauthenticated liveness
  GET  /v1/models             — bearer-auth, synthetic listing only
  POST /v1/chat/completions   — bearer-auth, model rewrite, SSE passthrough

All other paths/methods return 404 (catch-all).
"""

import asyncio
import hmac
import json
import os
import sys

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
_MAX_RESPONSE_BYTES = 2 * 1024 * 1024  # 2 MiB non-stream response cap

_CONNECT_TIMEOUT = 5
# The host ingress is capped at 32 minutes. Pixel Edge sits outside that
# trusted boundary, so both its total and no-first-byte budgets allow one
# additional minute before failing closed.
_TOTAL_TIMEOUT = 1980
_SOCK_READ_TIMEOUT = 1980
_MAX_SSE_LINE = 1024 * 1024

_UPSTREAM_REWRITE = "openclaw/default"
_PIXEL_REWRITE = "pixel/default"


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
                    return await _stream_upstream(request, resp)

                if "application/json" not in ctype:
                    return web.json_response({"error": "invalid upstream response"}, status=502)

                # Non-streaming: cap bytes, then rewrite model identifiers.
                resp_body = bytearray()
                async for chunk in resp.content.iter_any():
                    resp_body.extend(chunk)
                    if len(resp_body) > _MAX_RESPONSE_BYTES:
                        return web.json_response({"error": "upstream response too large"},
                                                 status=502)

                rewritten = _rewrite_json_model(bytes(resp_body))
                return web.Response(status=resp.status, body=rewritten,
                                    content_type="application/json")
    except (ConnectionError, OSError, asyncio.TimeoutError):
        return web.json_response({"error": "service unavailable"}, status=502)
    except Exception:
        return web.json_response({"error": "bad gateway"}, status=502)


async def _stream_upstream(request: web.Request, resp):
    """Stream bounded SSE lines while rewriting only exact JSON model fields."""
    response = web.StreamResponse(
        status=resp.status,
        headers={"Content-Type": "text/event-stream", "Cache-Control": "no-cache"},
    )
    await response.prepare(request)
    buffered = bytearray()
    try:
        async for chunk in resp.content.iter_any():
            buffered.extend(chunk)
            if len(buffered) > _MAX_SSE_LINE and b"\n" not in buffered:
                raise ValueError("SSE line exceeded limit")
            while b"\n" in buffered:
                line, _, remainder = buffered.partition(b"\n")
                buffered = bytearray(remainder)
                if len(line) > _MAX_SSE_LINE:
                    raise ValueError("SSE line exceeded limit")
                if line.startswith(b"data: ") and line != b"data: [DONE]":
                    line = b"data: " + _rewrite_json_model(line[6:])
                await response.write(line + b"\n")
        if buffered:
            if len(buffered) > _MAX_SSE_LINE:
                raise ValueError("SSE line exceeded limit")
            await response.write(bytes(buffered))
    except (ConnectionError, OSError, asyncio.TimeoutError):
        await response.write(b'data: {"error":"upstream error"}\n\ndata: [DONE]\n\n')
    except Exception:
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
    app.router.add_get("/health", handle_health)
    app.router.add_get("/v1/models", handle_models)
    app.router.add_post("/v1/chat/completions", handle_chat_completions)
    # Catch-all registered last: unmatched paths AND unmatched methods → 404.
    app.router.add_route("*", "/{tail:.*}", handle_not_found)
    return app


if __name__ == "__main__":
    web.run_app(create_app(), host="0.0.0.0", port=_LISTEN_PORT)
