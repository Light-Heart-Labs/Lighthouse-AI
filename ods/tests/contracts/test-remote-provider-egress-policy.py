#!/usr/bin/env python3
"""Remote-provider egress policy contracts."""

from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "bin"))

from remote_provider.policy import (  # noqa: E402
    ACTIVATION_RECEIPT_SCHEMA,
    FORBIDDEN_PUBLIC_SECRET_ENV,
    INTERNAL_EGRESS_BASE_URL,
    PUBLIC_MODEL_ALIAS,
    REDACTED,
    SCHEMA,
    PolicyError,
    load_policy,
    normalize_provider_base_url,
    plan_route,
    public_activation_receipt,
    validate_public_env_keys,
)
from remote_provider.transport import (  # noqa: E402
    DEFAULT_SSH_CONTROL_LISTEN_PORT,
    DEFAULT_SSH_IDENTITY_PATH,
    DEFAULT_SSH_INFERENCE_LISTEN_PORT,
    DEFAULT_SSH_KNOWN_HOSTS_PATH,
    DEFAULT_SSH_LOCAL_BIND_HOST,
    TransportError,
    build_ssh_tunnel_specs,
)
from remote_provider.reconciler import (  # noqa: E402
    PHASES,
    FakeActivationAdapter,
    result,
    run_activation_transaction,
)


POLICY_PATH = ROOT / "config" / "remote-provider-egress-policy.json"


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def assert_raises_policy_error(func, message: str) -> str:
    try:
        func()
    except PolicyError as exc:
        return str(exc)
    raise AssertionError(message)


def assert_raises_transport_error(func, message: str) -> str:
    try:
        func()
    except TransportError as exc:
        return str(exc)
    raise AssertionError(message)


def cloud_direct_env(**overrides: str) -> dict[str, str]:
    env = {
        "ODS_MODE": "cloud",
        "REMOTE_LLM_ENABLED": "true",
        "REMOTE_LLM_TRANSPORT": "direct",
        "REMOTE_LLM_BASE_URL": "https://gpu.example.test",
        "REMOTE_LLM_MODEL": "qwen/remote:latest",
    }
    env.update(overrides)
    return env


def cloud_ssh_env(**overrides: str) -> dict[str, str]:
    env = cloud_direct_env(
        REMOTE_LLM_TRANSPORT="ssh",
        REMOTE_LLM_BASE_URL="http://127.0.0.1:8000/v1",
        REMOTE_LLM_SSH_HOST="gpu.example.test",
        REMOTE_LLM_SSH_USER="ods",
        REMOTE_LLM_SSH_PORT="22",
        REMOTE_LLM_SSH_INFERENCE_HOST="127.0.0.1",
        REMOTE_LLM_SSH_INFERENCE_PORT="8000",
    )
    env.update(overrides)
    return env


def test_policy_document_shape() -> None:
    policy = load_policy(POLICY_PATH)
    assert_true(policy["schema"] == SCHEMA, "policy schema must be versioned")
    assert_true(policy["version"] == 1, "policy version must be 1")
    assert_true(
        policy["egress_service"]["internal_base_url"] == INTERNAL_EGRESS_BASE_URL,
        "egress service internal URL drifted",
    )
    assert_true(
        policy["egress_service"]["public_model_alias"] == PUBLIC_MODEL_ALIAS,
        "public model alias drifted",
    )
    assert_true(
        policy["activation"]["phases"] == list(PHASES),
        "activation policy must match reconciler phases",
    )
    forbidden = set(policy["secret_custody"]["public_env_forbidden"])
    assert_true(
        FORBIDDEN_PUBLIC_SECRET_ENV <= forbidden,
        "policy must list every forbidden public secret key",
    )
    schema_text = (ROOT / ".env.schema.json").read_text(encoding="utf-8")
    example_text = (ROOT / ".env.example").read_text(encoding="utf-8")
    for key in forbidden:
        assert_true(key not in schema_text, f"{key} must not be in public env schema")
        assert_true(key not in example_text, f"{key} must not be in public env example")
    direct_forbidden = set(
        policy["transports"]["direct"]["provider_base_url"]["forbid_ip_literal_classes"]
    )
    assert_true("non_global" in direct_forbidden, "direct policy must reject non-global IPs")
    tunnel = policy["transports"]["ssh"]["tunnel"]
    assert_true(tunnel["service_id"] == "remote-provider-ssh-tunnel", "SSH tunnel service id drifted")
    assert_true(tunnel["local_bind_host"] == DEFAULT_SSH_LOCAL_BIND_HOST, "SSH tunnel bind host drifted")
    assert_true(tunnel["inference_listen_port"] == DEFAULT_SSH_INFERENCE_LISTEN_PORT, "SSH inference port drifted")
    assert_true(tunnel["control_listen_port"] == DEFAULT_SSH_CONTROL_LISTEN_PORT, "SSH control port drifted")
    assert_true(tunnel["identity_file"] == str(DEFAULT_SSH_IDENTITY_PATH), "SSH identity path drifted")
    assert_true(tunnel["known_hosts_file"] == str(DEFAULT_SSH_KNOWN_HOSTS_PATH), "SSH known_hosts path drifted")
    assert_true(tunnel["forbid_user_ssh_config"] is True, "SSH transport must ignore user config")
    assert_true(tunnel["strict_host_key_checking"] is True, "SSH transport must enforce known_hosts")
    assert_true(tunnel["forward_agent"] is False, "SSH transport must forbid agent forwarding")


def test_direct_normalizes_public_https_roots() -> None:
    route = plan_route(cloud_direct_env())
    assert_true(route["enabled"] is True, "remote route should be enabled")
    assert_true(route["transport"] == "direct", "transport should be direct")
    assert_true(
        route["provider"]["baseUrl"] == "https://gpu.example.test/v1",
        "host root should normalize to /v1",
    )
    assert_true(
        normalize_provider_base_url(
            "https://GPU.example.test:9443/api/v1/",
            transport="direct",
        )
        == "https://gpu.example.test:9443/api/v1",
        "direct transport should accept /api/v1",
    )
    assert_true(
        route["egress"] == {
            "internalBaseUrl": INTERNAL_EGRESS_BASE_URL,
            "publicModel": PUBLIC_MODEL_ALIAS,
            "consumerRoute": "gateway",
        },
        "route must expose only the internal egress endpoint to consumers",
    )


def test_direct_rejects_unsafe_urls() -> None:
    unsafe_urls = [
        "http://gpu.example.test/v1",
        "https://user:token@gpu.example.test/v1",
        "https://gpu.example.test/v1?tenant=ods",
        "https://gpu.example.test/v1#fragment",
        "https://gpu.example.test\\v1",
        "https://gpu.example.test/proxy",
        "https://127.0.0.1:8000/v1",
        "https://[::1]:8000/v1",
        "https://10.0.0.5/v1",
        "https://169.254.1.10/v1",
        "https://224.0.0.1/v1",
        "https://255.255.255.255/v1",
        "https://localhost/v1",
        "https://host.docker.internal/v1",
    ]
    for url in unsafe_urls:
        assert_raises_policy_error(
            lambda url=url: plan_route(cloud_direct_env(REMOTE_LLM_BASE_URL=url)),
            f"direct transport accepted unsafe URL: {url}",
        )


def test_ssh_allows_remote_side_http_with_required_metadata() -> None:
    route = plan_route(cloud_ssh_env())
    assert_true(route["enabled"] is True, "SSH remote route should be enabled")
    assert_true(route["transport"] == "ssh", "transport should be ssh")
    assert_true(
        route["provider"]["baseUrl"] == "http://127.0.0.1:8000/v1",
        "SSH transport should allow remote-side loopback HTTP",
    )
    assert_true(route["ssh"]["host"] == "gpu.example.test", "SSH host missing")
    assert_true(route["ssh"]["port"] == 22, "SSH port must be numeric")
    assert_true(
        route["ssh"]["inferencePort"] == 8000,
        "SSH inference port must be numeric",
    )


def test_ssh_requires_transport_metadata() -> None:
    env = cloud_ssh_env()
    del env["REMOTE_LLM_SSH_INFERENCE_PORT"]
    detail = assert_raises_policy_error(
        lambda: plan_route(env),
        "SSH transport accepted missing inference port",
    )
    assert_true(
        "REMOTE_LLM_SSH_INFERENCE_PORT" in detail,
        "failure should name the missing SSH env key",
    )
    assert_raises_policy_error(
        lambda: plan_route(cloud_ssh_env(REMOTE_LLM_SSH_PORT="70000")),
        "SSH transport accepted an out-of-range SSH port",
    )


def test_ssh_transport_specs_are_structured_and_hardened() -> None:
    route = plan_route(
        cloud_ssh_env(
            REMOTE_LLM_SSH_CONTROL_HOST="127.0.0.1",
            REMOTE_LLM_SSH_CONTROL_PORT="8091",
        )
    )
    specs = build_ssh_tunnel_specs(route)
    assert_true(len(specs) == 2, "SSH route should build inference and control tunnels")
    inference, control = specs
    assert_true(inference.name == "inference", "first tunnel should be inference")
    assert_true(control.name == "control", "second tunnel should be control")
    assert_true(inference.listen_host == DEFAULT_SSH_LOCAL_BIND_HOST, "inference bind host drifted")
    assert_true(inference.listen_port == DEFAULT_SSH_INFERENCE_LISTEN_PORT, "inference bind port drifted")
    assert_true(control.listen_port == DEFAULT_SSH_CONTROL_LISTEN_PORT, "control bind port drifted")
    assert_true(
        "0.0.0.0:18091:127.0.0.1:8000" in inference.args,
        "inference forward must be explicit and internal",
    )
    assert_true(
        "0.0.0.0:18092:127.0.0.1:8091" in control.args,
        "control forward must be explicit and internal",
    )
    for spec in specs:
        assert_true(all(isinstance(arg, str) for arg in spec.args), "SSH command must be an argv list")
        assert_true("-F" in spec.args and "/dev/null" in spec.args, "SSH must ignore user config")
        assert_true("BatchMode=yes" in spec.args, "SSH must run in batch mode")
        assert_true("ExitOnForwardFailure=yes" in spec.args, "SSH must fail on forward failure")
        assert_true("ForwardAgent=no" in spec.args, "SSH must disable agent forwarding")
        assert_true("PermitLocalCommand=no" in spec.args, "SSH must disable local commands")
        assert_true("StrictHostKeyChecking=yes" in spec.args, "SSH must enforce known_hosts")
        assert_true(
            f"UserKnownHostsFile={DEFAULT_SSH_KNOWN_HOSTS_PATH}" in spec.args,
            "SSH must use the transport-owned known_hosts file",
        )
        assert_true(
            f"IdentityFile={DEFAULT_SSH_IDENTITY_PATH}" in spec.args,
            "SSH must use the transport-owned identity file",
        )
        joined = " ".join(spec.args)
        assert_true("ProxyCommand" not in joined, "SSH transport must not use ProxyCommand")
        assert_true("REMOTE_LLM_SSH_PRIVATE_KEY" not in joined, "SSH private key env must not be projected")
        assert_true(";" not in joined and "\n" not in joined, "SSH argv must not contain shell separators")


def test_ssh_transport_specs_reject_unsafe_tokens() -> None:
    route = plan_route(cloud_ssh_env())
    assert_raises_transport_error(
        lambda: build_ssh_tunnel_specs({**route, "transport": "direct"}),
        "direct routes should not build SSH specs",
    )
    unsafe_user = json.loads(json.dumps(route))
    unsafe_user["ssh"]["user"] = "ods;rm"
    assert_raises_transport_error(
        lambda: build_ssh_tunnel_specs(unsafe_user),
        "unsafe SSH user was accepted",
    )
    unsafe_host = json.loads(json.dumps(route))
    unsafe_host["ssh"]["host"] = "-oProxyCommand=sh"
    assert_raises_transport_error(
        lambda: build_ssh_tunnel_specs(unsafe_host),
        "unsafe SSH host was accepted",
    )


def test_public_env_forbids_remote_secrets() -> None:
    validate_public_env_keys(
        {
            "REMOTE_LLM_ENABLED": "true",
            "REMOTE_LLM_TRANSPORT": "direct",
            "REMOTE_LLM_BASE_URL": "https://gpu.example.test/v1",
            "REMOTE_LLM_MODEL": "qwen-remote",
        }
    )
    detail = assert_raises_policy_error(
        lambda: validate_public_env_keys(
            {
                "REMOTE_LLM_ENABLED": "true",
                "REMOTE_LLM_API_KEY": "unit-test-provider-token",
            }
        ),
        "public env accepted a provider API key",
    )
    assert_true("REMOTE_LLM_API_KEY" in detail, "failure should name the secret key")


def test_activation_receipt_redacts_secret_references() -> None:
    route = plan_route(cloud_direct_env())
    receipt = public_activation_receipt(
        route,
        phase="validate",
        ok=True,
        detail="metadata accepted",
        secret_refs={
            "REMOTE_LLM_API_KEY": "unit-test-provider-token",
            "REMOTE_ODS_PEER_TOKEN": "unit-test-peer-token",
        },
    )
    assert_true(receipt["schema"] == ACTIVATION_RECEIPT_SCHEMA, "receipt schema drifted")
    dumped = json.dumps(receipt, sort_keys=True)
    assert_true("unit-test-provider-token" not in dumped, "provider token leaked")
    assert_true("unit-test-peer-token" not in dumped, "peer token leaked")
    assert_true(REDACTED in dumped, "receipt should carry redacted secret refs")
    assert_true(
        receipt["provider"]["baseUrl"] == "https://gpu.example.test/v1",
        "receipt should keep non-secret provider metadata",
    )


def test_activation_transaction_orders_phases() -> None:
    adapter = FakeActivationAdapter()
    outcome = run_activation_transaction(adapter, cloud_direct_env())
    assert_true(outcome["ok"] is True, "happy path should succeed")
    assert_true(outcome["phase"] == "prove", "happy path must finish at prove")
    assert_true(adapter.calls == list(PHASES), "activation phases ran out of order")


def test_activation_transaction_fails_closed_and_rolls_back_after_commit() -> None:
    before_commit = FakeActivationAdapter(
        {"validate": [result(False, "metadata rejected")]}
    )
    failed = run_activation_transaction(before_commit, cloud_direct_env())
    assert_true(failed["ok"] is False, "validate failure should fail")
    assert_true(failed["phase"] == "validate", "failure phase should be validate")
    assert_true(
        before_commit.calls == ["stage", "validate"],
        "pre-commit failure should stop before commit",
    )
    assert_true("rollback" not in failed, "pre-commit failure must not roll back")

    after_commit = FakeActivationAdapter({"prove": [result(False, "probe failed")]})
    failed = run_activation_transaction(after_commit, cloud_direct_env())
    assert_true(failed["ok"] is False, "prove failure should fail")
    assert_true(failed["phase"] == "prove", "failure phase should be prove")
    assert_true(
        after_commit.calls == ["stage", "validate", "commit", "prove", "rollback"],
        "post-commit failure must roll back once",
    )
    assert_true(failed["rollback"]["ok"] is True, "rollback result should be attached")

    commit_failure = FakeActivationAdapter({"commit": [result(False, "swap failed")]})
    failed = run_activation_transaction(commit_failure, cloud_direct_env())
    assert_true(failed["ok"] is False, "commit failure should fail")
    assert_true(failed["phase"] == "commit", "failure phase should be commit")
    assert_true(
        commit_failure.calls == ["stage", "validate", "commit", "rollback"],
        "commit failure must request rollback once",
    )


def main() -> int:
    tests = [
        test_policy_document_shape,
        test_direct_normalizes_public_https_roots,
        test_direct_rejects_unsafe_urls,
        test_ssh_allows_remote_side_http_with_required_metadata,
        test_ssh_requires_transport_metadata,
        test_ssh_transport_specs_are_structured_and_hardened,
        test_ssh_transport_specs_reject_unsafe_tokens,
        test_public_env_forbids_remote_secrets,
        test_activation_receipt_redacts_secret_references,
        test_activation_transaction_orders_phases,
        test_activation_transaction_fails_closed_and_rolls_back_after_commit,
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
