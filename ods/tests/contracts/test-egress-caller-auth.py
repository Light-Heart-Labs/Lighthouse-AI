#!/usr/bin/env python3
"""remote-provider-egress must authenticate its callers.

The service is `expose:`d on the shared ods-network, reads the private
provider key from disk, and strips the caller's own Authorization before
injecting the provider bearer. Reachability therefore must not be the only
thing between a container and the victim's provider quota —
network-exposure-policy.json has declared `auth_required: true` for this
service all along.

Two layers, because the CI job that runs this installs only PyYAML and
jsonschema (the same reason test-remote-provider-egress-service.py imports the
shared library rather than the app):

  * source contracts, which need no third-party imports and always run;
  * live request checks against the real app, which run only where fastapi and
    httpx are importable and are skipped cleanly otherwise.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
APP_MAIN = ROOT / "extensions" / "services" / "remote-provider-egress" / "app" / "main.py"
POLICY = ROOT / "config" / "network-exposure-policy.json"

INTERNAL_KEY = "test-internal-key"

# Every route that can reach route state, the provider secret, or the upstream.
GUARDED_ROUTES = ('@app.get("/v1/models")', '@app.post("/probe")', "@app.api_route(")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def read_app_source() -> str:
    return APP_MAIN.read_text(encoding="utf-8")


# --- source contracts (always run) -----------------------------------------


def test_policy_declares_auth_required() -> None:
    entry = json.loads(POLICY.read_text(encoding="utf-8"))["services"]["remote-provider-egress"]
    assert_true(entry["auth_required"] is True,
                "remote-provider-egress policy must require auth")


def test_every_credentialed_route_checks_the_caller_key() -> None:
    """Each guarded decorator's handler must call the auth helper first."""
    source = read_app_source()
    for decorator in GUARDED_ROUTES:
        assert_true(decorator in source, f"expected route {decorator} in the egress app")
        body = source.split(decorator, 1)[1]
        # Look only as far as the next route decorator.
        next_route = body.find("\n@app.")
        if next_route != -1:
            body = body[:next_route]
        assert_true(
            "_internal_key_authorized(request)" in body,
            f"{decorator} must authenticate the caller before doing any work",
        )


def test_auth_helper_uses_constant_time_comparison() -> None:
    source = read_app_source()
    assert_true("secrets.compare_digest" in source,
                "the caller-key check must be a constant-time comparison")
    assert_true('encode("utf-8")' in source,
                "compare as UTF-8 bytes so a non-ASCII token cannot raise pre-auth")


def test_missing_key_denies_rather_than_allows() -> None:
    source = read_app_source()
    helper = source.split("def _internal_key_authorized", 1)[1].split("\ndef ", 1)[0]
    assert_true("if not INTERNAL_KEY:\n        return False" in helper,
                "an unconfigured key must deny, never allow-all")


def test_health_is_not_gated() -> None:
    """The compose healthcheck calls /health with no credential."""
    source = read_app_source()
    body = source.split('@app.get("/health")', 1)[1].split("\n@app.", 1)[0]
    assert_true("_internal_key_authorized" not in body,
                "/health must stay anonymous for the container healthcheck")


# --- live request checks (skipped without fastapi/httpx) --------------------


def load_app(temp: Path):
    import os

    (temp / "secrets").mkdir(parents=True, exist_ok=True)
    secret = temp / "secrets" / "provider-api-key"
    secret.write_text("dummy-provider-secret", encoding="utf-8")
    state = temp / "routing-state.json"
    state.write_text(json.dumps({"schema": "ods.remote-provider.v1"}), encoding="utf-8")

    os.environ["ODS_REMOTE_PROVIDER_ROUTE_PATH"] = str(state)
    os.environ["ODS_REMOTE_PROVIDER_API_KEY_FILE"] = str(secret)
    os.environ["ODS_EGRESS_INTERNAL_KEY"] = INTERNAL_KEY
    sys.path.insert(0, str(ROOT / "bin"))
    sys.path.insert(0, str(APP_MAIN.parent.parent))

    spec = importlib.util.spec_from_file_location("egress_app_under_test", APP_MAIN)
    if spec is None or spec.loader is None:
        raise AssertionError("could not load the egress app")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_live_checks() -> None:
    from fastapi.testclient import TestClient

    with tempfile.TemporaryDirectory(prefix="ods-egress-auth-") as temp:
        module = load_app(Path(temp))
        client = TestClient(module.app)
        body = {"model": "remote", "messages": [{"role": "user", "content": "hi"}]}

        for method, path, kwargs in (
            ("get", "/v1/models", {}),
            ("post", "/probe", {}),
            ("post", "/v1/chat/completions", {"json": body}),
        ):
            resp = getattr(client, method)(path, **kwargs)
            assert_true(
                resp.status_code == 401,
                f"{method.upper()} {path} must reject an unauthenticated peer, got {resp.status_code}",
            )
            assert_true(
                resp.json() == {"error": "unauthorized"},
                f"{method.upper()} {path} must fail on auth, not incidentally: {resp.text[:120]}",
            )
        print("[PASS] live: unauthenticated calls rejected on every guarded route")

        resp = client.get("/v1/models", headers={"Authorization": "Bearer wrong"})
        assert_true(resp.status_code == 401, f"a wrong key must be rejected, got {resp.status_code}")
        print("[PASS] live: wrong key rejected")

        # The disposable route state is not a usable remote route, so anything
        # other than 401 proves the request was authenticated.
        resp = client.get("/v1/models", headers={"Authorization": f"Bearer {INTERNAL_KEY}"})
        assert_true(resp.status_code != 401,
                    "a correctly keyed caller must get past the auth guard")
        print("[PASS] live: correct key passes authentication")

        resp = client.get("/health")
        assert_true(resp.status_code == 200,
                    f"/health must stay anonymous, got {resp.status_code}")
        assert_true("dummy-provider-secret" not in resp.text,
                    "/health must never echo provider key material")
        print("[PASS] live: /health anonymous and free of key material")


def main() -> int:
    for test in (
        test_policy_declares_auth_required,
        test_every_credentialed_route_checks_the_caller_key,
        test_auth_helper_uses_constant_time_comparison,
        test_missing_key_denies_rather_than_allows,
        test_health_is_not_gated,
    ):
        test()
        print(f"[PASS] {test.__name__}")

    try:
        import fastapi  # noqa: F401
        import httpx  # noqa: F401
    except ImportError:
        print("[SKIP] live request checks (fastapi/httpx not installed here)")
        return 0

    run_live_checks()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as exc:
        print(f"[FAIL] {exc}", file=sys.stderr)
        raise SystemExit(1)
