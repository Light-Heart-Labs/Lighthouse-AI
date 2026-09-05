"""Regression: extensions/services/tailscale/compose.yaml must set
security_opt: no-new-privileges:true, matching the convention already used
by every other ODS extension service compose file.

`no-new-privileges` is fully compatible with `cap_add` — it blocks a
process from gaining privileges beyond what it starts with (via setuid/
setgid binaries or file capabilities), it does not strip capabilities
already granted at container creation. Tailscale needs NET_ADMIN/NET_RAW
(already granted via cap_add) and nothing more, so this is a pure
hardening no-op for normal operation.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
COMPOSE_REL_PATH = "ods/extensions/services/tailscale/compose.yaml"
COMPOSE_PATH = REPO_ROOT / "ods" / "extensions" / "services" / "tailscale" / "compose.yaml"


def _load_prefix_yaml() -> dict:
    result = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "show", f"HEAD:{COMPOSE_REL_PATH}"],
        capture_output=True, text=True, check=True, encoding="utf-8",
    )
    return yaml.safe_load(result.stdout)


def test_prefix_was_missing_no_new_privileges():
    """Confirms the gap existed before this fix."""
    doc = _load_prefix_yaml()
    security_opt = doc["services"]["tailscale"].get("security_opt", [])
    assert "no-new-privileges:true" not in security_opt


def test_postfix_sets_no_new_privileges():
    doc = yaml.safe_load(COMPOSE_PATH.read_text(encoding="utf-8"))
    security_opt = doc["services"]["tailscale"].get("security_opt", [])
    assert "no-new-privileges:true" in security_opt


def test_postfix_still_has_required_capabilities():
    """No regression: NET_ADMIN/NET_RAW (Tailscale's mesh networking and NAT
    traversal) must still be present — no-new-privileges must not have been
    used as a substitute for the capabilities Tailscale actually needs."""
    doc = yaml.safe_load(COMPOSE_PATH.read_text(encoding="utf-8"))
    cap_add = doc["services"]["tailscale"].get("cap_add", [])
    assert "NET_ADMIN" in cap_add
    assert "NET_RAW" in cap_add


def test_postfix_compose_yaml_still_parses_as_valid_structure():
    doc = yaml.safe_load(COMPOSE_PATH.read_text(encoding="utf-8"))
    svc = doc["services"]["tailscale"]
    assert svc["network_mode"] == "host"
    assert svc["devices"] == ["/dev/net/tun:/dev/net/tun"]


if __name__ == "__main__":
    import sys
    sys.exit(pytest.main([__file__, "-v"]))
