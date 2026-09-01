"""Static contract checks for the Dream Worker host-agent boundary."""

from __future__ import annotations

import unittest
from pathlib import Path


ODS_ROOT = Path(__file__).resolve().parents[1]
HOST_AGENT = ODS_ROOT / "bin" / "ods-host-agent.py"


class DreamWorkerHostAgentContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = HOST_AGENT.read_text(encoding="utf-8")

    def test_client_is_imported(self) -> None:
        self.assertIn(
            "from dream_worker.client import (",
            self.source,
        )

    def test_status_route_exists(self) -> None:
        self.assertIn(
            'dream_path == "/v1/dream-worker/status"',
            self.source,
        )
        self.assertIn(
            "self._handle_dream_worker_status()",
            self.source,
        )

    def test_submit_route_exists(self) -> None:
        self.assertIn(
            'dream_path == "/v1/dream-worker/jobs"',
            self.source,
        )
        self.assertIn(
            "self._handle_dream_worker_submit()",
            self.source,
        )

    def test_get_and_cancel_routes_validate_job_ids(self) -> None:
        self.assertIn(
            r'r"/v1/dream-worker/jobs/([0-9a-fA-F]{32})"',
            self.source,
        )
        self.assertIn(
            r'r"/v1/dream-worker/jobs/([0-9a-fA-F]{32})/cancel"',
            self.source,
        )

    def test_every_handler_uses_host_agent_auth(self) -> None:
        handler_names = (
            "_handle_dream_worker_status",
            "_handle_dream_worker_get_job",
            "_handle_dream_worker_submit",
            "_handle_dream_worker_cancel",
        )

        for name in handler_names:
            start = self.source.index(f"    def {name}")
            next_method = self.source.find("\n    def ", start + 8)
            block = self.source[start:]

            if next_method >= 0:
                block = self.source[start:next_method]

            self.assertIn(
                "if not check_auth(self):",
                block,
                msg=name,
            )

    def test_worker_token_is_loaded_from_file(self) -> None:
        self.assertIn(
            '"dream-worker-token.txt"',
            self.source,
        )
        self.assertIn(
            'token_path.read_text(encoding="utf-8-sig").strip()',
            self.source,
        )
        self.assertNotIn(
            "worker.auth.token=",
            self.source,
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)