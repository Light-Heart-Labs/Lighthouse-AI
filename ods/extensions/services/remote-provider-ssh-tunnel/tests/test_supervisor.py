import json
import logging
from pathlib import Path
from unittest.mock import MagicMock, patch
import pytest

from app.main import (
    SshProcessSupervisor,
    _health_from_plan,
    _process_status,
)


def test_reconcile_handles_value_error_from_combined_ssh_argv():
    """
    Test that SshProcessSupervisor.reconcile catches ValueError from _combined_ssh_argv,
    logs it with exc_info=True, and reports status='invalid' in the health payload.
    """
    route_path = Path("fake_route.json")
    secret_dir = Path("fake_secrets")

    supervisor = SshProcessSupervisor(
        route_path=route_path, secret_dir=secret_dir, reconcile_interval=1.0
    )

    # Mock _supervisor_plan_for_paths to return a plan that will cause _combined_ssh_argv to fail.
    # Specifically, if readyToStart is True but tunnels are missing or malformed.
    bad_plan = {
        "ready": True,
        "status": "ready",
        "readyToStart": True,
        "tunnels": "not-a-list",  # This will trigger ValueError in _combined_ssh_argv
        "reason": "testing_value_error",
    }

    with (
        patch(
            "ods.extensions.services.remote_provider_ssh_tunnel.app.main._supervisor_plan_for_paths",
            return_value=bad_plan,
        ),
        patch(
            "ods.extensions.services.remote_provider_ssh_tunnel.app.main.LOGGER"
        ) as mock_logger,
    ):
        payload = supervisor.reconcile()

        # 1. Verify LOGGER.error was called with exc_info=True
        mock_logger.error.assert_called()
        args, kwargs = mock_logger.error.call_args
        assert kwargs.get("exc_info") is True

        # 2. Verify the payload status is "invalid"
        # Based on the architect plan: status: "invalid", reason: "ssh_argv_invalid", and errorType: "ValueError"
        # Note: The existing code uses _error_plan("ssh_plan_unavailable") in the catch block.
        # We need to check if the implementation matches the requested "ssh_argv_invalid".

        assert payload["status"] == "invalid"
        assert payload["reason"] == "ssh_argv_invalid"
        assert payload["process"]["errorType"] == "ValueError"


def test_reconcile_normal_flow_with_none_argv():
    """Verify that when argv is None (e.g. not ready), it still works."""
    route_path = Path("fake_route.json")
    secret_dir = Path("fake_secrets")
    supervisor = SshProcessSupervisor(route_path=route_path, secret_dir=secret_dir)

    not_ready_plan = {
        "ready": False,
        "status": "starting",
        "readyToStart": False,
        "tunnels": [],
    }

    with patch(
        "ods.extensions.services.remote_provider_ssh_tunnel.app.main._supervisor_plan_for_paths",
        return_value=not_ready_plan,
    ):
        payload = supervisor.reconcile()
        assert payload["status"] == "starting"
        assert payload["process"]["status"] == "stopped"
