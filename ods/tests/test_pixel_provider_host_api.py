"""Provider Settings through a real, disposable loopback host-agent HTTP server."""

from __future__ import annotations

import http.client
from http.server import ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bin"))
from pixel_provider.config import default_config


@unittest.skipUnless(os.name == "posix", "POSIX provider Settings persistence")
class HostHTTP(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("_pixel_provider_test_agent", ROOT / "bin/ods-host-agent.py")
        cls.agent = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = cls.agent
        spec.loader.exec_module(cls.agent)
        cls.agent.AGENT_API_KEY = "synthetic-provider-test-key"
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), cls.agent.AgentHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)
        sys.modules.pop("_pixel_provider_test_agent", None)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.agent.DATA_DIR = Path(self.temp.name)

    def request(self, method="GET", body=None, *, token="synthetic-provider-test-key", raw=None):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        try:
            path = "/v1/pixel/providers" + ("/save" if method == "POST" else "")
            payload = raw if raw is not None else json.dumps(body).encode() if body is not None else None
            connection.request(method, path, body=payload,
                               headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_real_http_cas_and_private_storage(self):
        status, initial = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(initial, default_config())
        self.assertEqual(list(self.agent.DATA_DIR.iterdir()), [])
        payload = {"expectedRevision": 0, "document": default_config()}
        status, saved = self.request("POST", payload)
        self.assertEqual(status, 200)
        self.assertEqual(saved["revision"], 1)
        self.assertFalse(saved["enabled"])
        self.assertEqual(self.request(), (200, saved))
        self.assertEqual(self.request("POST", payload)[0], 409)
        path = self.agent.DATA_DIR / "pixel-providers/provider-config.json"
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)

    def test_owner_auth_precedes_state_or_validation(self):
        for method in ("GET", "POST"):
            with self.subTest(method=method):
                self.assertEqual(self.request(method, {}, token="wrong")[0], 403)
        self.assertEqual(list(self.agent.DATA_DIR.iterdir()), [])

    def test_invalid_body_does_not_create_configuration(self):
        for raw in (b'{"expectedRevision":0,"expectedRevision":1,"document":{}}',
                    b'NaN', b'{"expectedRevision":true,"document":{}}',
                    b'{"expectedRevision":0,"document":{"secret":"do-not-echo"}}',
                    b'{"expectedRevision":0,"document":{"x":1e999}}'):
            with self.subTest(raw=raw[:30]):
                status, body = self.request("POST", raw=raw)
                self.assertEqual(status, 400)
                self.assertNotIn("do-not-echo", json.dumps(body))
        self.assertEqual(list(self.agent.DATA_DIR.iterdir()), [])

    def test_oversized_request_rejected(self):
        self.assertEqual(self.request("POST", raw=b"x" * (256 * 1024 + 1))[0], 413)

    def test_corrupt_disk_is_unavailable_not_empty(self):
        self.assertEqual(self.request("POST", {"expectedRevision": 0, "document": default_config()})[0], 200)
        path = self.agent.DATA_DIR / "pixel-providers/provider-config.json"
        path.write_bytes(b'{"secret":"do-not-echo"}')
        status, body = self.request()
        self.assertEqual(status, 503)
        self.assertNotIn("do-not-echo", json.dumps(body))


if __name__ == "__main__":
    unittest.main()
