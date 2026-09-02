#!/usr/bin/env bash
# Contract: Windows preflight must not treat a Podman docker CLI as Docker Desktop,
# and must not mark the engine running from client-only `docker version` JSON.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DET="$ROOT_DIR/installers/windows/lib/detection.ps1"
PRE="$ROOT_DIR/installers/windows/phases/01-preflight.ps1"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
PASS=0
FAIL=0
pass() { echo -e "  ${GREEN}PASS${NC} $1"; PASS=$((PASS + 1)); }
fail() { echo -e "  ${RED}FAIL${NC} $1"; FAIL=$((FAIL + 1)); }

echo ""
echo "=== Windows container-engine preflight ==="
echo ""

[[ -f "$DET" ]] && pass "detection.ps1 exists" || fail "detection.ps1 missing"
[[ -f "$PRE" ]] && pass "01-preflight.ps1 exists" || fail "01-preflight.ps1 missing"

if grep -q 'elseif ($versionJson.Client)' "$DET"; then
    fail "Test-DockerDesktop still treats Client-only version JSON as Running"
else
    pass "Running requires a Server object"
fi
if grep -q '\$versionJson.Server' "$DET" && grep -q '\$result.Running = \$true' "$DET"; then
    pass "Server presence gates Running"
else
    fail "Server gate missing"
fi
if grep -q '(?i)podman' "$DET" || grep -q "podman" "$DET"; then
    pass "detection classifies Podman from docker --version"
else
    fail "no Podman classification"
fi
if grep -q 'podman machine start' "$PRE"; then
    pass "preflight names podman machine start"
else
    fail "preflight missing Podman start hint"
fi
if grep -q 'Docker Desktop is not running' "$PRE"; then
    pass "Docker Desktop hint kept for non-Podman engines"
else
    fail "Docker Desktop down-hint missing"
fi

echo ""
echo "Result: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
