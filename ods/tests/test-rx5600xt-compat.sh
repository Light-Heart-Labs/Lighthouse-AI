#!/usr/bin/env bash
# RX 5600 XT / Navi 10 compatibility checks (classify + Vulkan backend).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PASS=0
FAIL=0
assert_eq() {
    local label="$1" expected="$2" actual="$3"
    if [[ "$expected" == "$actual" ]]; then
        echo "  PASS: $label"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: $label (expected '$expected', got '$actual')"
        FAIL=$((FAIL + 1))
    fi
}

json_field() {
    local py="python3"
    command -v python3 >/dev/null 2>&1 || py="python"
    "$py" -c "import json,sys; d=json.load(sys.stdin); print($1)"
}

_classify() {
    bash scripts/classify-hardware.sh --device-id "$1" --gpu-name "$2" --gpu-vendor "${3:-amd}" --vram-mb "${4:-0}" --memory-type "${5:-discrete}"
}

echo "=== RX 5600 XT classify-hardware ==="
assert_eq "5600 XT name" "rx_5600_xt" "$(_classify 0x731f "AMD Radeon RX 5600 XT" amd 6144 | json_field 'd["id"]')"
assert_eq "5700 XT name" "rx_5700_xt" "$(_classify 0x731f "AMD Radeon RX 5700 XT" amd 8192 | json_field 'd["id"]')"
assert_eq "5700 name" "rx_5700" "$(_classify 0x731f "AMD Radeon RX 5700" amd 8192 | json_field 'd["id"]')"
assert_eq "5600 name" "rx_5600" "$(_classify 0x731f "AMD Radeon RX 5600" amd 6144 | json_field 'd["id"]')"
assert_eq "5600 XT tier" "T1" "$(_classify 0x731f "AMD Radeon RX 5600 XT" amd 6144 | json_field 'd["recommended"]["tier"]')"
assert_eq "5600 XT bandwidth" "336" "$(_classify 0x731f "AMD Radeon RX 5600 XT" amd 6144 | json_field 'd["bandwidth_gbps"]')"
assert_eq "empty 6GB" "rx_5600_xt" "$(_classify 0x731f "" amd 6144 | json_field 'd["id"]')"
assert_eq "empty 8GB" "rx_5700_xt" "$(_classify 0x731f "" amd 8192 | json_field 'd["id"]')"

echo "=== gfx / Lemonade backend ==="
# shellcheck source=/dev/null
source installers/lib/amd-topo.sh
assert_eq "unknown discrete gfx" "unknown" "$(amd_gfx_fallback unknown discrete)"
assert_eq "unknown unified gfx" "gfx1151" "$(amd_gfx_fallback unknown unified)"
assert_eq "gfx1010 preserved" "gfx1010" "$(amd_gfx_fallback gfx1010 discrete)"
assert_eq "gfx1010 vulkan" "vulkan" "$(amd_lemonade_inference_backend gfx1010 discrete)"
assert_eq "gfx1030 vulkan" "vulkan" "$(amd_lemonade_inference_backend gfx1030 discrete)"
assert_eq "gfx1100 rocm" "rocm" "$(amd_lemonade_inference_backend gfx1100 discrete)"
assert_eq "gfx1151 rocm" "rocm" "$(amd_lemonade_inference_backend gfx1151 unified)"
assert_eq "unknown discrete vulkan" "vulkan" "$(amd_lemonade_inference_backend unknown discrete)"
assert_eq "unknown unified rocm" "rocm" "$(amd_lemonade_inference_backend unknown unified)"

echo "=== wiring ==="
grep -q 'GPU_COUNT -ge 1 && "$GPU_BACKEND" == "amd"' installers/phases/02-detection.sh \
    && { echo "  PASS: single-GPU AMD topology"; PASS=$((PASS + 1)); } \
    || { echo "  FAIL: single-GPU AMD topology"; FAIL=$((FAIL + 1)); }
grep -q 'amd_lemonade_inference_backend' installers/phases/06-directories.sh \
    && { echo "  PASS: phase 06 backend select"; PASS=$((PASS + 1)); } \
    || { echo "  FAIL: phase 06 backend select"; FAIL=$((FAIL + 1)); }
grep -q 'LEMONADE_LLAMACPP_BACKEND=${LEMONADE_LLAMACPP_BACKEND:-auto}' docker-compose.amd.yml \
    && { echo "  PASS: compose Vulkan env"; PASS=$((PASS + 1)); } \
    || { echo "  FAIL: compose Vulkan env"; FAIL=$((FAIL + 1)); }
grep -q 'AMD_INFERENCE_BACKEND:-rocm}" != "vulkan"' installers/phases/11-services.sh \
    && { echo "  PASS: skip HIP build on Vulkan"; PASS=$((PASS + 1)); } \
    || { echo "  FAIL: skip HIP build on Vulkan"; FAIL=$((FAIL + 1)); }

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
