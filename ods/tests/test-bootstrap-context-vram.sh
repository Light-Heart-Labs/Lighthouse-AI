#!/usr/bin/env bash
# Contract: the bootstrap fast-start must not raise MAX_CONTEXT to the 64K
# Hermes floor on a discrete GPU too small to hold the KV cache (#2927).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
. "$ROOT/installers/lib/bootstrap-model.sh"

PASS=0
FAIL=0
check() {
    local label="$1" expected="$2" got="$3"
    if [ "$got" = "$expected" ]; then
        echo "[PASS] $label (=$got)"
        PASS=$((PASS + 1))
    else
        echo "[FAIL] $label: expected $expected, got $got"
        FAIL=$((FAIL + 1))
    fi
}

# fitted context, VRAM MB, memory type
check "4GB discrete card keeps the tier-fitted context" \
    8192 "$(bootstrap_max_context 8192 4096 discrete)"
check "6GB discrete card keeps the tier-fitted context" \
    16384 "$(bootstrap_max_context 16384 6144 discrete)"

check "8GB discrete card reaches the 64K floor" \
    "$BOOTSTRAP_MAX_CONTEXT" "$(bootstrap_max_context 32768 8192 discrete)"
check "24GB discrete card reaches the 64K floor" \
    "$BOOTSTRAP_MAX_CONTEXT" "$(bootstrap_max_context 131072 24576 discrete)"

check "unified memory is exempt regardless of size" \
    "$BOOTSTRAP_MAX_CONTEXT" "$(bootstrap_max_context 8192 4096 unified)"
check "mixed memory is exempt" \
    "$BOOTSTRAP_MAX_CONTEXT" "$(bootstrap_max_context 8192 4096 mixed)"
check "CPU-only (no VRAM) is exempt" \
    "$BOOTSTRAP_MAX_CONTEXT" "$(bootstrap_max_context 8192 0 none)"

check "a fitted context already above the floor is not lowered" \
    "$BOOTSTRAP_MAX_CONTEXT" "$(bootstrap_max_context 131072 4096 discrete)"
check "an unknown fitted context falls back to the floor" \
    "$BOOTSTRAP_MAX_CONTEXT" "$(bootstrap_max_context 0 4096 discrete)"
check "an unknown memory type is not clamped" \
    "$BOOTSTRAP_MAX_CONTEXT" "$(bootstrap_max_context 8192 4096 "")"

# The clamp is worthless if phase 11 still assigns the constant directly.
if grep -q 'MAX_CONTEXT="$(bootstrap_max_context "$FULL_MAX_CONTEXT"' \
        "$ROOT/installers/phases/11-services.sh"; then
    echo "[PASS] phase 11 routes the bootstrap context through bootstrap_max_context"
    PASS=$((PASS + 1))
else
    echo "[FAIL] phase 11 must set MAX_CONTEXT via bootstrap_max_context"
    FAIL=$((FAIL + 1))
fi

echo "------------------------------------------------------------"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
