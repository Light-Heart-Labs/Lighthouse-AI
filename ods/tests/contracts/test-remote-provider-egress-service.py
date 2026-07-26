#!/usr/bin/env python3
"""Remote-provider egress service contracts."""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "bin"))

from remote_provider.egress import (  # noqa: E402
    EgressError,
    prepare_upstream_request,
    provider_secret_status,
    route_from_state,
)


BASE_COMPOSE = ROOT / "docker-compose.base.yml"
MANIFEST = ROOT / "extensions" / "services" / "remote-provider-egress" / "manifest.yaml"
DOCKERFILE = ROOT / "extensions" / "services" / "remote-provider-egress" / "Dockerfile"
APP_MAIN = ROOT / "extensions" / "services" / "remote-provider-egress" / "app" / "main.py"
POLICY = ROOT / "config" / "remote-provider-egress-policy.json"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def assert_egress_error(func, code: str) -> EgressError:
    try:
        func()
    except EgressError as exc:
        assert_true(exc.code == code, f"expected {code}, got {exc.code}")
        return exc
    raise AssertionError(f"expected EgressError {code}")


def route_state(**provider_overrides: str) -> dict[str, object]:
    provider = {
        "capability": "openai-compatible",
        "baseUrl": "https://gpu.example.test/v1",
        "model": "qwen/remote:latest",
        "transport": "direct",
    }
    provider.update(provider_overrides)
    return {
        "schema": "ods.remote-routing-state.v1",
        "enabled": True,
        "mode": "cloud",
        "provider": provider,
        "projection": {
            "publicModel": "ods/current",
            "gateway": "litellm-cloud",
            "egressBaseUrl": "http://remote-provider-egress:8091/v1",
            "consumerRoute": "gateway",
        },
        "status": {"proven": False, "reason": "pending-provider-handshake"},
    }


def test_compose_service_is_internal_only_and_hardened() -> None:
    compose = read(BASE_COMPOSE)
    assert_true("  remote-provider-egress:" in compose, "base compose must define remote-provider-egress")
    block = compose.split("  remote-provider-egress:", 1)[1].split("\n  # ", 1)[0]
    assert_true("dockerfile: extensions/services/remote-provider-egress/Dockerfile" in block, "service must use its Dockerfile")
    assert_true("image: ods-remote-provider-egress:local" in block, "service image must be local-only")
    assert_true("expose:" in block and '"8091"' in block, "service must expose only the internal port")
    assert_true("ports:" not in block, "service must not bind a host port")
    assert_true("cap_drop:" in block and "- ALL" in block, "service must drop capabilities")
    assert_true("read_only: true" in block, "service filesystem must be read-only")
    assert_true("/remote-provider/secrets/provider-api-key" in block, "service must use a secret file path")
    assert_true("REMOTE_LLM_API_KEY" not in block, "service must not source provider API keys from public env")


def test_manifest_and_network_policy_mark_no_lan_exposure() -> None:
    manifest = read(MANIFEST)
    exposure = json.loads(read(ROOT / "config" / "network-exposure-policy.json"))
    assert_true("id: remote-provider-egress" in manifest, "manifest must declare service id")
    assert_true("external_port_default: 0" in manifest, "manifest must prevent host URL fallback")
    assert_true("category: core" in manifest, "egress service should be a core internal service")
    assert_true("compose_file:" not in manifest, "base-stack service manifest must not add an extension overlay")
    entry = exposure["services"]["remote-provider-egress"]
    assert_true(entry["lan_exposure"] == "none", "egress service must have no LAN exposure")
    assert_true(entry["auth_required"] is True, "egress service must require private provider auth")


def test_image_copies_shared_policy_package() -> None:
    dockerfile = read(DOCKERFILE)
    assert_true("COPY bin/remote_provider ./remote_provider" in dockerfile, "image must copy shared policy helpers")
    assert_true("USER odsremote" in dockerfile, "image must run as non-root service user")
    assert_true("--no-server-header" in dockerfile, "uvicorn should suppress server banner")


def test_route_state_prepares_direct_provider_request_without_client_auth() -> None:
    route = route_from_state(route_state())
    upstream = prepare_upstream_request(
        method="POST",
        path="/v1/chat/completions",
        headers={
            "authorization": "Bearer client-token",
            "x-request-id": "abc",
            "connection": "close",
        },
        body=json.dumps({"model": "ods/current", "messages": []}).encode("utf-8"),
        route=route,
        provider_secret="unit-test-provider-token",
    )
    assert_true(upstream.url == "https://gpu.example.test/v1/chat/completions", "provider URL/path join drifted")
    assert_true(json.loads(upstream.content)["model"] == "qwen/remote:latest", "provider model must replace public alias")
    assert_true(upstream.requested_model == "ods/current", "requested alias should be retained as metadata")
    assert_true(upstream.headers["authorization"] == "Bearer unit-test-provider-token", "provider auth must be injected")
    assert_true("client-token" not in json.dumps(upstream.headers), "client auth must not be forwarded")
    assert_true("connection" not in {key.lower() for key in upstream.headers}, "hop-by-hop headers must be stripped")


def test_egress_fails_closed_without_secret_or_supported_transport() -> None:
    route = route_from_state(route_state())
    assert_egress_error(
        lambda: prepare_upstream_request(
            method="POST",
            path="/v1/chat/completions",
            headers={},
            body=b'{"model":"ods/current"}',
            route=route,
            provider_secret="",
        ),
        "missing_provider_secret",
    )
    assert_egress_error(
        lambda: route_from_state(route_state(transport="ssh", baseUrl="http://127.0.0.1:8000/v1")),
        "ssh_transport_deferred",
    )


def test_secret_file_status_is_support_bundle_safe() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        missing = Path(tmp) / "provider-api-key"
        assert_true(provider_secret_status(missing)["configured"] is False, "missing secret should be unconfigured")
        missing.write_text("unit-test-provider-token", encoding="utf-8")
        status = provider_secret_status(missing)
        dumped = json.dumps(status)
        assert_true(status["configured"] is True, "non-empty secret file should be configured")
        assert_true("unit-test-provider-token" not in dumped, "secret status must not include secret value")


def test_service_source_avoids_public_env_secret_names() -> None:
    text = read(APP_MAIN)
    assert_true("REMOTE_LLM_API_KEY" not in text, "app must not read provider key from public env")
    assert_true("ODS_REMOTE_PROVIDER_API_KEY_FILE" in text, "app must read only the provider key file path")
    assert_true("read_provider_secret" in text, "app must use shared secret-file helper")
    assert_true(POLICY.exists(), "policy document must exist for mounted service config")


def main() -> int:
    tests = [
        test_compose_service_is_internal_only_and_hardened,
        test_manifest_and_network_policy_mark_no_lan_exposure,
        test_image_copies_shared_policy_package,
        test_route_state_prepares_direct_provider_request_without_client_auth,
        test_egress_fails_closed_without_secret_or_supported_transport,
        test_secret_file_status_is_support_bundle_safe,
        test_service_source_avoids_public_env_secret_names,
    ]
    for test in tests:
        test()
        print(f"[PASS] {test.__name__}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as exc:
        print(f"[FAIL] {exc}", file=sys.stderr)
        raise SystemExit(1)
