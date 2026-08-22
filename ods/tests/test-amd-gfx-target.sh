#!/usr/bin/env bash
# Contract: ODS must read the real gfx target from KFD topology, and must never
# guess an architecture when it cannot (#2844).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
. "$ROOT/installers/lib/amd-topo.sh"

PASS=0
FAIL=0
check() {
    local label="$1" expected="$2" got="$3"
    if [ "$got" = "$expected" ]; then
        echo "[PASS] $label (=$got)"
        PASS=$((PASS + 1))
    else
        echo "[FAIL] $label: expected '$expected', got '$got'"
        FAIL=$((FAIL + 1))
    fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# make_node <root> <index> <simd_count> <gfx_target_version>
make_node() {
    mkdir -p "$1/$2"
    printf 'cpu_cores_count 16\nsimd_count %s\ngfx_target_version %s\n' "$3" "$4" \
        > "$1/$2/properties"
}

# The reporting host from #2844: node 0 is the CPU node, node 1 is the RX 9060 XT.
R="$TMP/navi44"; make_node "$R" 0 0 0; make_node "$R" 1 64 120000
check "gfx1200 (RX 9060 XT) read past the CPU node" \
    "gfx1200" "$(KFD_TOPOLOGY_ROOT="$R" amd_kfd_gfx_target)"

# The CPU node must never be the answer — that is what produced the misdetection.
R="$TMP/cpuonly"; make_node "$R" 0 0 0
set +e
got="$(KFD_TOPOLOGY_ROOT="$R" amd_kfd_gfx_target)"; rc=$?
set -e
check "a CPU-only topology reports unknown" "unknown" "$got"
check "...and signals failure" "1" "$rc"

R="$TMP/halo"; make_node "$R" 0 0 0; make_node "$R" 1 32 110501
check "gfx1151 (Strix Halo) still resolves" \
    "gfx1151" "$(KFD_TOPOLOGY_ROOT="$R" amd_kfd_gfx_target)"

# Hex step digit: 90010 -> gfx90a, not gfx9010.
R="$TMP/mi250"; make_node "$R" 0 0 0; make_node "$R" 1 104 90010
check "gfx90a (MI250) encodes the step in hex" \
    "gfx90a" "$(KFD_TOPOLOGY_ROOT="$R" amd_kfd_gfx_target)"

R="$TMP/mi300"; make_node "$R" 0 0 0; make_node "$R" 1 304 90402
check "gfx942 (MI300X) resolves" \
    "gfx942" "$(KFD_TOPOLOGY_ROOT="$R" amd_kfd_gfx_target)"

R="$TMP/missing"
mkdir -p "$R"
set +e
got="$(KFD_TOPOLOGY_ROOT="$R" amd_kfd_gfx_target)"
set -e
check "an empty topology dir reports unknown" "unknown" "$got"

# ── The refusal ─────────────────────────────────────────────────────────────
PHASE="$ROOT/installers/phases/06-directories.sh"

if grep -q '_amd_gfx_detected="gfx1151"' "$PHASE"; then
    echo "[FAIL] phase 06 still falls back to a hardcoded gfx1151"
    FAIL=$((FAIL + 1))
else
    echo "[PASS] phase 06 has no hardcoded gfx1151 fallback"
    PASS=$((PASS + 1))
fi

if grep -q 'refusing to write a guessed AMDGPU_TARGET' "$PHASE"; then
    echo "[PASS] phase 06 aborts when the target cannot be resolved"
    PASS=$((PASS + 1))
else
    echo "[FAIL] phase 06 must abort rather than guess an AMDGPU_TARGET"
    FAIL=$((FAIL + 1))
fi

if grep -q 'AMDGPU_TARGET=gfx1200 ./install.sh' "$PHASE"; then
    echo "[PASS] the abort tells the operator how to set the target manually"
    PASS=$((PASS + 1))
else
    echo "[FAIL] the abort must name the AMDGPU_TARGET escape hatch"
    FAIL=$((FAIL + 1))
fi

echo "------------------------------------------------------------"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
