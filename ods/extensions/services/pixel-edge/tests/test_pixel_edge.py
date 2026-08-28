"""Tests for pixel_edge — upstream Unix socket + edge proxy routes."""

import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import warnings

warnings.filterwarnings("ignore", message=".*Sending a large body.*")
warnings.filterwarnings("ignore", message=".*ResourceWarning.*")

from aiohttp import web, ClientSession, UnixConnector  # noqa: E402

SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

TOKEN = "test-token-abc123-0123456789abcdef"


# ---------------------------------------------------------------------------
# Mock upstream on a Unix socket
# ---------------------------------------------------------------------------

async def _upstream_chat(request):
    data = await request.json()
    stream = data.get("stream", False)

    if data.get("trigger_error"):
        return web.json_response({"error": "upstream-secret-path-/private/token"}, status=500)

    if stream:
        async def generate():
            yield b'data: {"id":"1","model":"openclaw/default","choices":[]}\n\n'
            yield b'data: {"id":"2","model":"openclaw/default","choices":[{"delta":{"content":"openclaw/default is assistant text"}}]}\n\n'
            yield b'data: [DONE]\n\n'
        resp = web.StreamResponse(
            status=200,
            headers={"Content-Type": "text/event-stream", "Cache-Control": "no-cache"},
        )
        await resp.prepare(request)
        async for chunk in generate():
            await resp.write(chunk)
        await resp.write_eof()
        return resp

    return web.json_response({
        "id": "chat-1",
        "model": "openclaw/default",
        "choices": [{"message": {"content": "openclaw/default is assistant text"}}],
    })


async def _upstream_models(_request):
    return web.json_response({
        "object": "list",
        "data": [{"id": "openclaw/default", "object": "model", "owned_by": "openclaw"}],
    })


async def _upstream_health(_request):
    return web.json_response({"status": "ok"})


async def _start_upstream():
    fd, path = tempfile.mkstemp(suffix=".sock")
    os.close(fd)
    os.unlink(path)
    app = web.Application()
    app.router.add_post("/v1/chat/completions", _upstream_chat)
    app.router.add_get("/v1/models", _upstream_models)
    app.router.add_get("/health", _upstream_health)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.UnixSite(runner, path)
    await site.start()
    return path, runner


async def _stop_upstream(runner, path=None):
    await runner.cleanup()
    if path:
        try:
            os.unlink(path)
        except OSError:
            pass


def _set_env(sock_path):
    os.environ["PIXEL_OPENWEBUI_KEY"] = TOKEN
    os.environ["PIXEL_INGRESS_SOCKET"] = sock_path


# ---------------------------------------------------------------------------
# Base test: real edge app + mock upstream
# ---------------------------------------------------------------------------

class BaseEdgeTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.up_sock, self.up_runner = await _start_upstream()
        _set_env(self.up_sock)

        import importlib
        import pixel_edge
        self.pe = importlib.reload(pixel_edge)

        self.edge_app = self.pe.create_app()
        self.edge_runner = web.AppRunner(self.edge_app)
        await self.edge_runner.setup()

        fd, self.edge_sock = tempfile.mkstemp(suffix=".edge.sock")
        os.close(fd)
        os.unlink(self.edge_sock)
        self.edge_site = web.UnixSite(self.edge_runner, self.edge_sock)
        await self.edge_site.start()

        self.client = ClientSession(connector=UnixConnector(path=self.edge_sock))

    async def asyncTearDown(self):
        await self.client.close()
        await self.edge_runner.cleanup()
        await _stop_upstream(self.up_runner, self.up_sock)
        try:
            os.unlink(self.edge_sock)
        except OSError:
            pass

    def auth(self):
        return {"Authorization": f"Bearer {TOKEN}"}


# ---------------------------------------------------------------------------
# Startup config validation
# ---------------------------------------------------------------------------

class TestConfigValidation(unittest.TestCase):
    def setUp(self):
        # Pytest preserves source order and reaches this class before any
        # BaseEdgeTest has imported pixel_edge. Load one known-good module
        # first so each case exercises the intended reload boundary rather
        # than raising outside assertRaises during an initial import.
        _set_env("/tmp/pixel-edge-config-test.sock")
        import importlib
        import pixel_edge
        self.pixel_edge = importlib.reload(pixel_edge)

    def _reload_with_env(self, env):
        old = {k: os.environ.get(k) for k in
               ("PIXEL_OPENWEBUI_KEY", "PIXEL_INGRESS_SOCKET")}
        for k, v in old.items():
            if v is not None:
                os.environ[k] = v
        for k, v in env.items():
            os.environ[k] = v
        return old

    def _restore(self, old):
        for k, v in old.items():
            if v is not None:
                os.environ[k] = v
            else:
                os.environ.pop(k, None)

    def test_blank_token_exits(self):
        old = self._reload_with_env({"PIXEL_OPENWEBUI_KEY": ""})
        try:
            import importlib
            with self.assertRaises(SystemExit):
                importlib.reload(self.pixel_edge)
        finally:
            self._restore(old)

    def test_missing_token_exits(self):
        old = self._reload_with_env({})
        os.environ.pop("PIXEL_OPENWEBUI_KEY", None)
        try:
            import importlib
            with self.assertRaises(SystemExit):
                importlib.reload(self.pixel_edge)
        finally:
            self._restore(old)

    def test_oversized_token_exits(self):
        old = self._reload_with_env({"PIXEL_OPENWEBUI_KEY": "x" * 4097})
        try:
            import importlib
            with self.assertRaises(SystemExit):
                importlib.reload(self.pixel_edge)
        finally:
            self._restore(old)

    def test_short_or_whitespace_token_exits(self):
        for value in ("too-short", "x" * 31, ("x" * 32) + "\n"):
            old = self._reload_with_env({"PIXEL_OPENWEBUI_KEY": value})
            try:
                import importlib
                with self.assertRaises(SystemExit):
                    importlib.reload(self.pixel_edge)
            finally:
                self._restore(old)

    def test_chat_timeout_budget_outlives_private_host_ingress(self):
        self.assertEqual(self.pixel_edge._TOTAL_TIMEOUT, 1980)
        self.assertEqual(self.pixel_edge._SOCK_READ_TIMEOUT, 1980)


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

class TestHealth(BaseEdgeTest):
    async def test_health_ok_no_auth(self):
        async with self.client.get("http://localhost/health") as resp:
            self.assertEqual(resp.status, 200)
            self.assertEqual(await resp.json(), {"status": "ok"})

    async def test_health_fails_closed_when_ingress_socket_is_absent(self):
        original = self.pe._SOCKET_PATH
        self.pe._SOCKET_PATH = "/tmp/definitely-missing-pixel-ingress.sock"
        try:
            async with self.client.get("http://localhost/health") as resp:
                self.assertEqual(resp.status, 503)
                self.assertEqual(await resp.json(), {"status": "unavailable"})
        finally:
            self.pe._SOCKET_PATH = original

    async def test_models_fail_closed_when_ingress_socket_is_absent(self):
        original = self.pe._SOCKET_PATH
        self.pe._SOCKET_PATH = "/tmp/definitely-missing-pixel-ingress.sock"
        try:
            async with self.client.get(
                "http://localhost/v1/models", headers=self.auth()
            ) as resp:
                self.assertEqual(resp.status, 503)
                self.assertEqual(await resp.json(), {"error": "service unavailable"})
        finally:
            self.pe._SOCKET_PATH = original


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

class TestAuth(BaseEdgeTest):
    async def test_models_missing_auth(self):
        async with self.client.get("http://localhost/v1/models") as resp:
            self.assertEqual(resp.status, 401)

    async def test_models_wrong_token(self):
        async with self.client.get("http://localhost/v1/models",
                                   headers={"Authorization": "Bearer wrong"}) as resp:
            self.assertEqual(resp.status, 401)

    async def test_models_correct_token(self):
        async with self.client.get("http://localhost/v1/models",
                                   headers=self.auth()) as resp:
            self.assertEqual(resp.status, 200)

    async def test_chat_missing_auth(self):
        async with self.client.post("http://localhost/v1/chat/completions",
                                    json={"model": "pixel/default", "messages": []}) as resp:
            self.assertEqual(resp.status, 401)

    async def test_chat_wrong_token(self):
        async with self.client.post("http://localhost/v1/chat/completions",
                                    headers={"Authorization": "Bearer wrong"},
                                    json={"model": "pixel/default", "messages": []}) as resp:
            self.assertEqual(resp.status, 401)


# ---------------------------------------------------------------------------
# Refused routes / methods
# ---------------------------------------------------------------------------

class TestRefusedRoutes(BaseEdgeTest):
    async def test_unknown_path(self):
        async with self.client.get("http://localhost/unknown") as resp:
            self.assertEqual(resp.status, 404)

    async def test_post_to_models(self):
        async with self.client.post("http://localhost/v1/models", headers=self.auth()) as resp:
            self.assertEqual(resp.status, 404)

    async def test_delete_to_chat(self):
        async with self.client.delete("http://localhost/v1/chat/completions") as resp:
            self.assertEqual(resp.status, 404)

    async def test_get_to_health_wrong_method(self):
        async with self.client.post("http://localhost/health") as resp:
            self.assertEqual(resp.status, 404)


# ---------------------------------------------------------------------------
# Content type
# ---------------------------------------------------------------------------

class TestContentType(BaseEdgeTest):
    async def test_wrong_content_type(self):
        async with self.client.post(
            "http://localhost/v1/chat/completions",
            headers={**self.auth(), "Content-Type": "text/plain"},
            data="not json") as resp:
            self.assertEqual(resp.status, 415)


# ---------------------------------------------------------------------------
# Model allowlist / rewrite
# ---------------------------------------------------------------------------

class TestModelAllowlist(BaseEdgeTest):
    async def test_allowed_model_ok(self):
        async with self.client.post(
            "http://localhost/v1/chat/completions",
            headers=self.auth(),
            json={"model": "pixel/default", "messages": []}) as resp:
            self.assertEqual(resp.status, 200)

    async def test_disallowed_model(self):
        async with self.client.post(
            "http://localhost/v1/chat/completions",
            headers=self.auth(),
            json={"model": "gpt-4", "messages": []}) as resp:
            self.assertEqual(resp.status, 400)

    async def test_json_not_object(self):
        async with self.client.post(
            "http://localhost/v1/chat/completions",
            headers=self.auth(),
            json=["not", "an", "object"]) as resp:
            self.assertEqual(resp.status, 400)


# ---------------------------------------------------------------------------
# Header stripping
# ---------------------------------------------------------------------------

class TestHeaderStripping(BaseEdgeTest):
    async def test_blocked_headers_never_forwarded(self):
        from pixel_edge import _sanitize_headers, _HOP_BY_HOP

        inbound = {
            "Authorization": "Bearer client-token",
            "Cookie": "session=123",
            "X-Openclaw-Auth": "secret",
            "X-Openclaw-Session": "sess-1",
            "X-Openclaw-Token": "tok-1",
            "X-Openclaw-Future-Privileged": "must-also-be-blocked",
            "X-Forwarded-For": "1.2.3.4",
            "X-Forwarded-Host": "proxy",
            "X-Forwarded-Proto": "https",
            "Forwarded": "for=1.2.3.4",
            "Via": "proxy",
            "X-Real-Ip": "1.2.3.4",
            "Connection": "keep-alive",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "test",
            "X-Custom-Unsafe": "should-be-blocked",
        }
        sanitized = _sanitize_headers(inbound)
        keys = {k.lower() for k in sanitized}

        blocked = {
            "authorization", "cookie", "x-openclaw-auth", "x-openclaw-session",
            "x-openclaw-token", "x-openclaw-future-privileged", "x-forwarded-for", "x-forwarded-host",
            "x-forwarded-proto", "forwarded", "via", "x-real-ip",
        }
        for bh in blocked | _HOP_BY_HOP:
            self.assertNotIn(bh, keys, f"{bh} was forwarded")
        self.assertNotIn("x-custom-unsafe", keys)
        self.assertNotIn("Content-Type", sanitized)
        self.assertIn("Accept", sanitized)
        self.assertIn("User-Agent", sanitized)

    async def test_edge_never_forwards_browser_auth_to_upstream(self):
        seen = {}

        async def capture(request):
            seen["authorization"] = request.headers.get("Authorization", "")
            data = await request.json()
            seen["model"] = data.get("model")
            seen["cookie"] = request.headers.get("Cookie", "")
            seen["xopenclaw"] = request.headers.get("X-Openclaw-Auth", "")
            seen["xforwarded"] = request.headers.get("X-Forwarded-For", "")
            return web.json_response({"id": "1", "model": "openclaw/default", "choices": []})

        fd, path = tempfile.mkstemp(suffix=".cap.sock")
        os.close(fd)
        os.unlink(path)
        app = web.Application()
        app.router.add_post("/v1/chat/completions", capture)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.UnixSite(runner, path)
        await site.start()

        try:
            import importlib
            import pixel_edge
            os.environ["PIXEL_INGRESS_SOCKET"] = path
            importlib.reload(pixel_edge)

            cap_app = pixel_edge.create_app()
            cap_runner = web.AppRunner(cap_app)
            await cap_runner.setup()
            fd2, cap_sock = tempfile.mkstemp(suffix=".cap.edge.sock")
            os.close(fd2)
            os.unlink(cap_sock)
            cap_site = web.UnixSite(cap_runner, cap_sock)
            await cap_site.start()

            async with ClientSession(connector=UnixConnector(path=cap_sock)) as c:
                async with c.post(
                    "http://localhost/v1/chat/completions",
                    headers={**self.auth(), "Cookie": "session=secret",
                             "X-Openclaw-Auth": "secret-key",
                             "X-Forwarded-For": "1.2.3.4"},
                    json={"model": "pixel/default", "messages": []}) as resp:
                    self.assertEqual(resp.status, 200)

            self.assertFalse(seen.get("authorization"))
            self.assertEqual(seen.get("model"), "openclaw/default")
            self.assertFalse(seen.get("cookie"))
            self.assertFalse(seen.get("xopenclaw"))
            self.assertFalse(seen.get("xforwarded"))

            await cap_runner.cleanup()
            os.unlink(cap_sock)
        finally:
            os.environ["PIXEL_INGRESS_SOCKET"] = self.up_sock
            importlib.reload(pixel_edge)
            await runner.cleanup()
            os.unlink(path)


# ---------------------------------------------------------------------------
# Size limit
# ---------------------------------------------------------------------------

class TestSizeLimit(BaseEdgeTest):
    async def test_oversized_body_rejected(self):
        big = json.dumps({"model": "pixel/default",
                          "messages": [{"role": "user", "content": "x" * (2 * 1024 * 1024 + 1)}]})
        async with self.client.post(
            "http://localhost/v1/chat/completions",
            headers={**self.auth(), "Content-Type": "application/json"},
            data=io.BytesIO(big.encode())) as resp:
            self.assertEqual(resp.status, 413)

    async def test_invalid_json(self):
        async with self.client.post(
            "http://localhost/v1/chat/completions",
            headers={**self.auth(), "Content-Type": "application/json"},
            data=b"{invalid json}") as resp:
            self.assertEqual(resp.status, 400)


# ---------------------------------------------------------------------------
# Synthetic model list
# ---------------------------------------------------------------------------

class TestSyntheticModels(BaseEdgeTest):
    async def test_models_is_synthetic(self):
        async with self.client.get("http://localhost/v1/models",
                                   headers=self.auth()) as resp:
            self.assertEqual(resp.status, 200)
            data = await resp.json()
            self.assertEqual(data["object"], "list")
            ids = [m["id"] for m in data["data"]]
            self.assertIn("pixel/default", ids)
            self.assertNotIn("openclaw/default", ids)
            for m in data["data"]:
                self.assertEqual(m["owned_by"], "pixel")


# ---------------------------------------------------------------------------
# Response rewrite
# ---------------------------------------------------------------------------

class TestResponseRewrite(BaseEdgeTest):
    async def test_non_stream_model_rewritten(self):
        async with self.client.post(
            "http://localhost/v1/chat/completions",
            headers=self.auth(),
            json={"model": "pixel/default", "messages": [{"role": "user", "content": "hi"}]}) as resp:
            self.assertEqual(resp.status, 200)
            data = await resp.json()
            self.assertEqual(data.get("model"), "pixel/default")
            self.assertEqual(
                data["choices"][0]["message"]["content"],
                "openclaw/default is assistant text",
            )


# ---------------------------------------------------------------------------
# SSE incremental passthrough
# ---------------------------------------------------------------------------

class TestSSE(BaseEdgeTest):
    async def test_sse_streams_incrementally(self):
        async with self.client.post(
            "http://localhost/v1/chat/completions",
            headers=self.auth(),
            json={"model": "pixel/default", "messages": [], "stream": True}) as resp:
            self.assertEqual(resp.status, 200)
            self.assertIn("text/event-stream", resp.headers.get("Content-Type", ""))
            self.assertEqual(resp.headers.get("Cache-Control"), "no-cache")

            collected = []
            async for chunk in resp.content.iter_any():
                collected.append(chunk)
                self.assertIsInstance(chunk, bytes)
                self.assertTrue(len(chunk) > 0)

            full = b"".join(collected).decode()
            self.assertIn('data: {"id": "1"', full)
            self.assertIn('data: [DONE]', full)
            self.assertIn('"model": "pixel/default"', full)
            self.assertIn('"content": "openclaw/default is assistant text"', full)


# ---------------------------------------------------------------------------
# Sanitized upstream errors
# ---------------------------------------------------------------------------

class TestSanitizedErrors(BaseEdgeTest):
    async def test_upstream_error_body_is_not_forwarded(self):
        async with self.client.post(
            "http://localhost/v1/chat/completions",
            headers=self.auth(),
            json={"model": "pixel/default", "messages": [], "trigger_error": True},
        ) as resp:
            self.assertEqual(resp.status, 502)
            body = await resp.text()
            self.assertIn("pixel request rejected", body)
            self.assertNotIn("upstream-secret", body)
            self.assertNotIn("private/token", body)

    async def test_upstream_down_returns_502(self):
        # Point edge at a dead socket by overriding module global
        import pixel_edge
        old = pixel_edge._SOCKET_PATH
        dead = tempfile.mktemp(suffix=".dead.sock")
        pixel_edge._SOCKET_PATH = dead

        try:
            app = pixel_edge.create_app()
            runner = web.AppRunner(app)
            await runner.setup()
            fd, sock = tempfile.mkstemp(suffix=".dead.edge.sock")
            os.close(fd)
            os.unlink(sock)
            site = web.UnixSite(runner, sock)
            await site.start()

            async with ClientSession(connector=UnixConnector(path=sock)) as c:
                async with c.post(
                    "http://localhost/v1/chat/completions",
                    headers=self.auth(),
                    json={"model": "pixel/default", "messages": []}) as resp:
                    self.assertEqual(resp.status, 502)
                    data = await resp.json()
                    self.assertIn("error", data)
                    self.assertNotIn(dead, json.dumps(data))
                    self.assertNotIn("Traceback", json.dumps(data))

            await runner.cleanup()
            os.unlink(sock)
        finally:
            pixel_edge._SOCKET_PATH = old


if __name__ == "__main__":
    unittest.main()
