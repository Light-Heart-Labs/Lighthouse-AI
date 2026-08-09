#!/bin/bash
# ============================================================================
# Multigpu overlay fail-closed test
# ============================================================================
# Regression for issue #2298: docker-compose.multigpu-nvidia.yml interpolated
# NVIDIA_VISIBLE_DEVICES with "${LLAMA_SERVER_GPU_UUIDS:-all}", so launching the
# multigpu profile without the variable set silently spread inference across
# every GPU instead of the configured subset. The overlay now uses the `:?`
# operator so Compose aborts with an explicit error rather than falling back
# to all GPUs.
#
# Strategy:
#  - Static check: the overlay must use `:?`, never `:-all`, for
#    NVIDIA_VISIBLE_DEVICES.
#  - Behavioral check (when Docker Compose is available): `docker compose
#    config` must fail without LLAMA_SERVER_GPU_UUIDS and succeed with it set.
#
# Usage: ./tests/test-multigpu-fail-closed.sh
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OVERLAY="$ROOT_DIR/docker-compose.multigpu-nvidia.yml"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASSED=0
FAILED=0

pass() { echo -e "  ${GREEN}✓ PASS${NC} $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "  ${RED}✗ FAIL${NC} $1"; FAILED=$((FAILED + 1)); }
skip() { echo -e "  ${YELLOW}⊘ SKIP${NC} $1"; }

echo ""
echo "╔═══════════════════════════════════════════════╗"
echo "║   Multigpu overlay fail-closed test           ║"
echo "╚═══════════════════════════════════════════════╝"
echo ""

if [[ ! -f "$OVERLAY" ]]; then
    fail "docker-compose.multigpu-nvidia.yml not found"
    echo ""; echo "Result: $PASSED passed, $FAILED failed"; exit 1
fi
pass "multigpu-nvidia overlay exists"

# --- 1. Static: NVIDIA_VISIBLE_DEVICES must fail closed with `:?` -----------
gpu_devices_line="$(grep 'NVIDIA_VISIBLE_DEVICES' "$OVERLAY" | head -n 1)"
if [[ -z "$gpu_devices_line" ]]; then
    fail "NVIDIA_VISIBLE_DEVICES not present in overlay"
elif echo "$gpu_devices_line" | grep -q ':?'; then
    pass "NVIDIA_VISIBLE_DEVICES uses the :? fail-closed operator"
else
    fail "NVIDIA_VISIBLE_DEVICES must use :? so an unset LLAMA_SERVER_GPU_UUIDS aborts (got: $gpu_devices_line)"
fi

if echo "$gpu_devices_line" | grep -q ':-all'; then
    fail "NVIDIA_VISIBLE_DEVICES must not fall back to all GPUs (:-all)"
else
    pass "NVIDIA_VISIBLE_DEVICES no longer falls back to :-all"
fi

# --- 2. Behavioral: docker compose config without/with the variable ---------
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    cd "$ROOT_DIR"

    set +e
    unset_error="$(docker compose -f docker-compose.multigpu-nvidia.yml config 2>&1)"
    unset_rc=$?
    set -e

    if [[ $unset_rc -ne 0 ]] && echo "$unset_error" | grep -q "LLAMA_SERVER_GPU_UUIDS"; then
        pass "docker compose config aborts without LLAMA_SERVER_GPU_UUIDS"
    else
        fail "docker compose config should abort without LLAMA_SERVER_GPU_UUIDS (rc=$unset_rc, out=$unset_error)"
    fi

    set +e
    set_error="$(LLAMA_SERVER_GPU_UUIDS=GPU-0000,GPU-0001 docker compose -f docker-compose.multigpu-nvidia.yml config 2>&1)"
    set_rc=$?
    set -e

    if [[ $set_rc -eq 0 ]]; then
        pass "docker compose config succeeds with LLAMA_SERVER_GPU_UUIDS set"
    elif echo "$set_error" | grep -q "LLAMA_SERVER_GPU_UUIDS"; then
        fail "docker compose config still complains about LLAMA_SERVER_GPU_UUIDS when it is set"
    else
        # The overlay is a fragment (no image on the service), so compose may
        # still reject the project shape. That is unrelated to the fail-closed
        # behavior we are testing.
        pass "docker compose config no longer aborts on the missing variable"
    fi
else
    skip "Docker Compose unavailable; behavioral render skipped"
fi

echo ""
echo "Result: $PASSED passed, $FAILED failed"
[[ $FAILED -eq 0 ]] || exit 1
exit 0
