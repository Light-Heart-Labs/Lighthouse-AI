#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

command -v jq >/dev/null 2>&1 || {
    echo "[FAIL] jq is required"
    exit 1
}

classify() {
    bash scripts/classify-hardware.sh \
        --platform-id linux \
        --gpu-vendor nvidia \
        --memory-type "$1" \
        --vram-mb "$2" \
        --ram-mb "$3" \
        --gpu-name "$4"
}

# Device IDs are not always available (containers and restricted sysfs are
# common examples), so the installer's production fallback is name matching.
# "Grace Blackwell" also contains the earlier, generic "Blackwell" alias.
grace_class="$(classify unified 0 131072 'NVIDIA Grace Blackwell')"
jq -e '
    .id == "nvidia_grace_blackwell_gb10"
    and .memory_source == "ram"
    and .bandwidth_gbps == 273
' <<<"$grace_class" >/dev/null || {
    echo "[FAIL] Grace Blackwell must beat the generic Blackwell alias"
    exit 1
}

# The specificity rule must not redirect the workstation product whose name
# owns the broad alias.
workstation_class="$(classify discrete 98304 128000 'NVIDIA RTX PRO 6000 Blackwell')"
jq -e '
    .id == "rtx_pro_6000_blackwell"
    and .memory_source == "vram"
    and .bandwidth_gbps == 1792
' <<<"$workstation_class" >/dev/null || {
    echo "[FAIL] RTX PRO 6000 Blackwell classification changed unexpectedly"
    exit 1
}

echo "[PASS] hardware name matching prefers the most specific shipped alias"
