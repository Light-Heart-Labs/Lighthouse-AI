#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() { echo "[FAIL] $*" >&2; exit 1; }

grep -F 'ODS_AGENT_HOST=$(Get-EnvOrNew "ODS_AGENT_HOST" "host.docker.internal")' \
    "$ROOT_DIR/installers/windows/lib/env-generator.ps1" >/dev/null \
    || fail "windows env-generator.ps1 missing ODS_AGENT_HOST default"
grep -F 'local agent_host="host.docker.internal"' \
    "$ROOT_DIR/installers/macos/lib/env-generator.sh" >/dev/null \
    || fail "macos env-generator.sh missing agent_host fallback"
grep -F 'agent_host="$macos_host_gateway"' \
    "$ROOT_DIR/installers/macos/lib/env-generator.sh" >/dev/null \
    || fail "macos env-generator.sh missing macos_host_gateway agent_host"
grep -F 'ODS_AGENT_HOST=${ODS_AGENT_HOST:-${agent_host}}' \
    "$ROOT_DIR/installers/macos/lib/env-generator.sh" >/dev/null \
    || fail "macos env-generator.sh missing ODS_AGENT_HOST export"
grep -F 'ODS_AGENT_HOST=${ODS_AGENT_HOST:-}' \
    "$ROOT_DIR/docker-compose.base.yml" >/dev/null \
    || fail "docker-compose.base.yml missing ODS_AGENT_HOST env var"
grep -F '"ODS_AGENT_HOST"' "$ROOT_DIR/.env.schema.json" >/dev/null \
    || fail ".env.schema.json missing ODS_AGENT_HOST definition"
grep -F '# ODS_AGENT_HOST=host.docker.internal' "$ROOT_DIR/.env.example" >/dev/null \
    || fail ".env.example missing ODS_AGENT_HOST example"

echo "[PASS] desktop installers route dashboard-api to the platform-safe host-agent endpoint"
