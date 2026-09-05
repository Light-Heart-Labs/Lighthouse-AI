#!/bin/bash
# ============================================================================
# ODS host-arch.sh Test Suite
# ============================================================================
# Ensures installers/lib/host-arch.sh's detect_host_arch() maps uname -m
# output to the Docker/OCI arch names it promises (amd64, arm64, unknown).
#
# Usage: ./tests/test-host-arch.sh
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

PASSED=0
FAILED=0

pass() { echo -e "  ${GREEN}✓ PASS${NC} $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "  ${RED}✗ FAIL${NC} $1"; FAILED=$((FAILED + 1)); }

echo ""
echo "╔═══════════════════════════════════════════════╗"
echo "║   host-arch.sh Test Suite                      ║"
echo "╚═══════════════════════════════════════════════╝"
echo ""

if [[ ! -f "$ROOT_DIR/installers/lib/host-arch.sh" ]]; then
    fail "installers/lib/host-arch.sh not found"
    echo ""; echo "Result: $PASSED passed, $FAILED failed"; exit 1
fi
pass "host-arch.sh exists"

# shellcheck disable=SC1090,SC1091
. "$ROOT_DIR/installers/lib/host-arch.sh"

if [[ "$(type -t detect_host_arch)" == "function" ]]; then
    pass "detect_host_arch is defined after sourcing"
else
    fail "detect_host_arch should be defined after sourcing"
    echo ""; echo "Result: $PASSED passed, $FAILED failed"; exit 1
fi

check_arch() {
    local uname_output="$1" expected="$2" label="$3"
    local actual
    actual="$(uname() { echo "$uname_output"; }; detect_host_arch)"
    if [[ "$actual" == "$expected" ]]; then
        pass "$label"
    else
        fail "$label: expected '$expected', got '$actual'"
    fi
}

check_arch "x86_64" "amd64" "uname -m=x86_64 maps to amd64"
check_arch "amd64" "amd64" "uname -m=amd64 (already OCI-named) maps to amd64"
check_arch "aarch64" "arm64" "uname -m=aarch64 maps to arm64"
check_arch "arm64" "arm64" "uname -m=arm64 (already OCI-named) maps to arm64"
check_arch "riscv64" "unknown" "uname -m=riscv64 (unrecognized) maps to unknown"
check_arch "armv7l" "unknown" "uname -m=armv7l (32-bit ARM, unrecognized) maps to unknown"

echo ""
echo "Result: $PASSED passed, $FAILED failed"
[[ $FAILED -eq 0 ]]
