"""Tests for dashboard-api remote-provider status."""

from __future__ import annotations

import json


def _route_state(
    model: str = "qwen/remote:latest",
    *,
    status: dict[str, object] | None = None,
) -> dict[str, object]:
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
        "status": status or {"proven": False, "reason": "pending-provider-handshake"},
    }


def _lifecycle_payload() -> dict[str, object]:
    return {
        "action": "test",
        "provider": {
            "transport": "direct",
            "baseUrl": "https://gpu.example.test",
            "model": "qwen/remote:latest",
        },
        "secrets": {"apiKey": "unit-test-provider-token"},
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
    assert body["availableActions"]["configure"] is True
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


def test_remote_provider_status_exposes_sanitized_probe_receipt(
    test_client,
    monkeypatch,
    tmp_path,
):
    status = {
        "proven": True,
        "reason": "provider-handshake-ok",
        "lastProbe": {
            "schema": "ods.remote-provider-probe-receipt.v1",
            "ok": True,
            "verifiedAt": "2026-07-26T00:00:00+00:00",
            "endpoint": "/v1/models",
            "httpStatus": 200,
            "contentType": "application/json",
            "modelCount": 1,
            "resolution": {"ok": True, "addressCount": 1, "raw": "93.184.216.34"},
            "value": "unit-test-provider-token",
        },
    }
    state_path = tmp_path / "routing-state.json"
    state_path.write_text(json.dumps(_route_state(status=status)), encoding="utf-8")
    rps = _patch_state_path(monkeypatch, state_path)

    async def fake_fetch():
        return {
            "reachable": True,
            "valid": True,
            "ready": True,
            "status": "ok",
            "reason": "ready",
            "secret": {"configured": True, "bytes": 24},
            "resolution": {"ok": True, "addressCount": 1},
        }

    monkeypatch.setattr(rps, "_fetch_egress_health", fake_fetch)

    resp = test_client.get(
        "/api/remote-provider/status",
        headers=test_client.auth_headers,
    )

    body = resp.json()
    dumped = json.dumps(body, sort_keys=True)
    assert resp.status_code == 200
    assert body["status"] == "ready"
    assert body["routeState"]["status"] == {
        "proven": True,
        "reason": "provider-handshake-ok",
        "lastProbe": {
            "schema": "ods.remote-provider-probe-receipt.v1",
            "ok": True,
            "verifiedAt": "2026-07-26T00:00:00+00:00",
            "endpoint": "/v1/models",
            "httpStatus": 200,
            "contentType": "application/json",
            "modelCount": 1,
            "resolution": {"ok": True, "addressCount": 1},
        },
    }
    assert "unit-test-provider-token" not in dumped
    assert "93.184.216.34" not in dumped


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


def test_remote_provider_plan_requires_auth(test_client):
    resp = test_client.post("/api/remote-provider/plan", json=_lifecycle_payload())
    assert resp.status_code == 401


def test_remote_provider_plan_proxies_to_host_agent(
    test_client,
    monkeypatch,
):
    from routers import remote_provider_status as rps

    calls = []

    async def fake_request(method, path, *, payload, timeout):
        calls.append((method, path, payload, timeout))
        return {
            "schema": "ods.remote-provider-lifecycle-operation.v1",
            "action": "test",
            "ok": True,
            "route": {
                "enabled": True,
                "provider": {
                    "baseUrl": "https://gpu.example.test/v1",
                    "model": "qwen/remote:latest",
                    "transport": "direct",
                },
            },
            "writes": {"routingState": False},
            "secretRefs": {
                "REMOTE_LLM_API_KEY": {"present": True, "value": "[REDACTED]"}
            },
        }

    monkeypatch.setattr(rps, "async_request_agent_json", fake_request)

    resp = test_client.post(
        "/api/remote-provider/plan",
        json=_lifecycle_payload(),
        headers=test_client.auth_headers,
    )

    assert resp.status_code == 200
    body = resp.json()
    dumped = json.dumps(body, sort_keys=True)
    assert body["action"] == "test"
    assert body["secretRefs"]["REMOTE_LLM_API_KEY"]["value"] == "[REDACTED]"
    assert "unit-test-provider-token" not in dumped
    assert calls == [
        ("POST", "/v1/remote-provider/plan", _lifecycle_payload(), 10)
    ]


def test_remote_provider_plan_preserves_host_agent_validation_errors(
    test_client,
    monkeypatch,
):
    from routers import remote_provider_status as rps

    async def fake_request(*_args, **_kwargs):
        raise rps.AgentHTTPError(400, "remote provider base URL is required")

    monkeypatch.setattr(rps, "async_request_agent_json", fake_request)

    resp = test_client.post(
        "/api/remote-provider/plan",
        json={"action": "configure"},
        headers=test_client.auth_headers,
    )

    assert resp.status_code == 400
    assert resp.json()["detail"] == "remote provider base URL is required"


def test_remote_provider_apply_requires_auth(test_client):
    resp = test_client.post("/api/remote-provider/apply", json=_lifecycle_payload())
    assert resp.status_code == 401


def test_remote_provider_apply_proxies_to_host_agent(
    test_client,
    monkeypatch,
):
    from routers import remote_provider_status as rps

    calls = []

    async def fake_request(method, path, *, payload, timeout):
        calls.append((method, path, payload, timeout))
        return {
            "schema": "ods.remote-provider-lifecycle-operation.v1",
            "action": "configure",
            "ok": True,
            "applied": True,
            "mutated": True,
            "rollback": {"attempted": False, "ok": None},
            "secretRefs": {
                "REMOTE_LLM_API_KEY": {"present": True, "value": "[REDACTED]"}
            },
        }

    monkeypatch.setattr(rps, "async_request_agent_json", fake_request)
    payload = _lifecycle_payload()
    payload["action"] = "configure"

    resp = test_client.post(
        "/api/remote-provider/apply",
        json=payload,
        headers=test_client.auth_headers,
    )

    body = resp.json()
    dumped = json.dumps(body, sort_keys=True)
    assert resp.status_code == 200
    assert body["action"] == "configure"
    assert body["mutated"] is True
    assert "unit-test-provider-token" not in dumped
    assert calls == [("POST", "/v1/remote-provider/apply", payload, 10)]


def test_remote_provider_apply_preserves_host_agent_validation_errors(
    test_client,
    monkeypatch,
):
    from routers import remote_provider_status as rps

    async def fake_request(*_args, **_kwargs):
        raise rps.AgentHTTPError(500, "Remote provider apply failed: disk full")

    monkeypatch.setattr(rps, "async_request_agent_json", fake_request)

    resp = test_client.post(
        "/api/remote-provider/apply",
        json=_lifecycle_payload(),
        headers=test_client.auth_headers,
    )

    assert resp.status_code == 500
    assert resp.json()["detail"] == "Remote provider apply failed: disk full"
