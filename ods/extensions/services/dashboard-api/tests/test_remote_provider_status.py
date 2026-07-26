"""Tests for dashboard-api remote-provider status."""

from __future__ import annotations

import json


def _route_state(model: str = "qwen/remote:latest") -> dict[str, object]:
    return {
        "schema": "ods.remote-routing-state.v1",
        "enabled": True,
        "mode": "cloud",
        "provider": {
            "capability": "openai-compatible",
            "baseUrl": "https://gpu.example.test/v1",
            "model": model,
            "transport": "direct",
        },
        "projection": {
            "publicModel": "ods/current",
            "gateway": "litellm-cloud",
            "egressBaseUrl": "http://remote-provider-egress:8091/v1",
            "consumerRoute": "gateway",
        },
        "status": {"proven": False, "reason": "pending-provider-handshake"},
    }


def _patch_state_path(monkeypatch, path):
    from routers import remote_provider_status as rps

    monkeypatch.setattr(rps, "_state_path", lambda: path)
    return rps


def test_remote_provider_status_requires_auth(test_client):
    resp = test_client.get("/api/remote-provider/status")
    assert resp.status_code == 401


def test_remote_provider_status_missing_state_is_disabled(
    test_client,
    monkeypatch,
    tmp_path,
):
    rps = _patch_state_path(monkeypatch, tmp_path / "missing.json")

    async def fake_fetch():
        return {
            "reachable": True,
            "valid": True,
            "ready": False,
            "status": "disabled",
            "reason": "remote_route_disabled",
            "secret": {"configured": False, "bytes": 0},
            "resolution": None,
        }

    monkeypatch.setattr(rps, "_fetch_egress_health", fake_fetch)

    resp = test_client.get(
        "/api/remote-provider/status",
        headers=test_client.auth_headers,
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "disabled"
    assert body["routeState"]["exists"] is False
    assert body["routeState"]["valid"] is True
    assert body["routeState"]["provider"] is None
    assert body["availableActions"]["test"] is False


def test_remote_provider_status_sanitizes_egress_secret_health(
    test_client,
    monkeypatch,
    tmp_path,
):
    state_path = tmp_path / "routing-state.json"
    state_path.write_text(json.dumps(_route_state()), encoding="utf-8")
    rps = _patch_state_path(monkeypatch, state_path)

    async def fake_fetch():
        return rps._sanitize_egress_health(
            {
                "status": "ok",
                "ready": True,
                "reason": "ready",
                "secret": {
                    "configured": True,
                    "bytes": 24,
                    "path": "/state/remote-provider/secrets/provider-api-key",
                    "value": "unit-test-provider-token",
                },
                "resolution": {"ok": True, "addressCount": 1},
            }
        )

    monkeypatch.setattr(rps, "_fetch_egress_health", fake_fetch)

    resp = test_client.get(
        "/api/remote-provider/status",
        headers=test_client.auth_headers,
    )

    assert resp.status_code == 200
    body = resp.json()
    dumped = json.dumps(body, sort_keys=True)
    assert body["status"] == "ready"
    assert body["routeState"]["enabled"] is True
    assert body["routeState"]["provider"]["model"] == "qwen/remote:latest"
    assert body["egress"]["secret"] == {"configured": True, "bytes": 24}
    assert body["egress"]["resolution"] == {
        "ok": True,
        "reason": "",
        "addressCount": 1,
    }
    assert "unit-test-provider-token" not in dumped
    assert "provider-api-key" not in dumped
    assert body["capabilities"]["odsPeerLifecycle"] is False


def test_remote_provider_status_invalid_state_is_diagnostic(
    test_client,
    monkeypatch,
    tmp_path,
):
    state_path = tmp_path / "routing-state.json"
    state_path.write_text("{not json", encoding="utf-8")
    rps = _patch_state_path(monkeypatch, state_path)

    async def fake_fetch():
        return {
            "reachable": True,
            "valid": True,
            "ready": False,
            "status": "disabled",
            "reason": "remote_route_disabled",
            "secret": {"configured": False, "bytes": 0},
            "resolution": None,
        }

    monkeypatch.setattr(rps, "_fetch_egress_health", fake_fetch)

    resp = test_client.get(
        "/api/remote-provider/status",
        headers=test_client.auth_headers,
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "invalid"
    assert body["routeState"]["valid"] is False
    assert body["routeState"]["errors"]


def test_remote_provider_status_reports_unreachable_egress(
    test_client,
    monkeypatch,
    tmp_path,
):
    state_path = tmp_path / "routing-state.json"
    state_path.write_text(json.dumps(_route_state()), encoding="utf-8")
    rps = _patch_state_path(monkeypatch, state_path)

    async def fake_fetch():
        return {
            "reachable": False,
            "valid": False,
            "ready": False,
            "status": "unreachable",
            "reason": "egress_unreachable",
            "secret": {"configured": False, "bytes": None},
            "resolution": None,
        }

    monkeypatch.setattr(rps, "_fetch_egress_health", fake_fetch)

    resp = test_client.get(
        "/api/remote-provider/status",
        headers=test_client.auth_headers,
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "degraded"
    assert body["egress"]["reachable"] is False
    assert body["egress"]["reason"] == "egress_unreachable"
