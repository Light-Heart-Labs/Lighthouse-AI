#!/usr/bin/env python3
"""Static contracts for the remote-provider ods CLI lifecycle surface."""

from __future__ import annotations

import re
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[2]
ODS_CLI = ROOT_DIR / "ods-cli"


def fail(message: str) -> None:
    print(f"[FAIL] {message}")
    raise SystemExit(1)


def require(pattern: str, text: str, message: str) -> None:
    if not re.search(pattern, text, flags=re.MULTILINE):
        fail(message)


def main() -> int:
    text = ODS_CLI.read_text(encoding="utf-8")

    require(
        r"^cmd_remote_provider\(\) \{",
        text,
        "ods-cli must implement remote-provider lifecycle command",
    )
    require(
        r"remote-provider \[status\|plan\|configure\|test\|disable\|remove\]",
        text,
        "remote-provider command must be visible in top-level help",
    )
    require(
        r"remote-provider\)\s+shift; cmd_remote_provider \"\$@\" ;;",
        text,
        "remote-provider command must be dispatched by the main CLI",
    )
    for endpoint in (
        "/api/remote-provider/status",
        "/api/remote-provider/plan",
        "/api/remote-provider/probe",
        "/api/remote-provider/apply",
    ):
        require(re.escape(endpoint), text, f"CLI must call {endpoint}")

    require(
        r"printf 'Authorization: Bearer %s\\n' \"\$api_key\" \|[\s\S]*--header @-",
        text,
        "Dashboard API bearer token must be streamed through stdin, not argv",
    )
    require(
        r"--data-binary @\"\$payload_file\"",
        text,
        "remote-provider lifecycle payload must be sent from a private file",
    )
    require(
        r"chmod 600 \"\$payload_file\" \"\$response_file\"",
        text,
        "remote-provider request and response files must be owner-only",
    )
    require(
        r"Raw --api-key is not supported",
        text,
        "CLI must reject raw provider API keys in command arguments",
    )
    require(
        r"remote-provider \$action does not accept provider or secret options",
        text,
        "disable/remove must reject irrelevant provider or secret options",
    )
    if "--api-key VALUE" in text or "--api-key <" in text:
        fail("remote-provider help must not advertise raw --api-key values")
    if '"$REMOTE_LLM_API_KEY"' in text:
        fail("top-level help must escape REMOTE_LLM_API_KEY under set -u")

    secret_reader = re.search(
        r"^_remote_provider_read_secret\(\) \{(?P<body>[\s\S]*?)^\}\s*$",
        text,
        flags=re.MULTILINE,
    )
    if secret_reader is None:
        fail("remote-provider secret reader could not be parsed")
    if "_env_get_raw" in secret_reader.group("body"):
        fail("provider API keys must not be read from public .env keys")

    remote_provider_function = re.search(
        r"^cmd_remote_provider\(\) \{(?P<body>[\s\S]*?)^\}\s*$",
        text,
        flags=re.MULTILINE,
    )
    if remote_provider_function is None:
        fail("remote-provider function could not be parsed")
    body = remote_provider_function.group("body")
    for subcommand in ("status", "plan", "configure", "test", "disable", "remove"):
        if subcommand not in body:
            fail(f"remote-provider CLI missing subcommand: {subcommand}")
    require(
        r"^_remote_provider_probe_configured\(\) \{",
        text,
        "remote-provider CLI must support configured-route egress probes",
    )
    require(
        r"_remote_provider_request POST /api/remote-provider/probe",
        text,
        "configured remote-provider test must call the egress probe endpoint",
    )
    require(
        r"if \[\[ \"\$use_configured_probe\" == \"true\" \]\]; then[\s\S]*_remote_provider_probe_configured \"\$@\"",
        body,
        "remote-provider test must use configured-route probe when provider options are absent",
    )

    print("[PASS] remote-provider CLI static contract")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
