#!/usr/bin/env bash
# ============================================================================
# WSL2 NVIDIA GPU detection contract
#
# Regression guard for scripts/detect-hardware.sh::detect_nvidia().
#
# The sysfs vendor scan (/sys/class/drm/card*/device/vendor == 0x10de) exists so
# a stray nvidia-smi -- e.g. nvidia-container-toolkit installed on an AMD-only
# box -- cannot be mistaken for NVIDIA hardware. WSL2 exposes no
# /sys/class/drm/card* entries at all, so on WSL2 that scan finds nothing even
# though CUDA works and nvidia-smi reports the GPU.
#
# installers/lib/detection.sh already falls back to nvidia-smi as the sole
# hardware witness under WSL2; scripts/detect-hardware.sh carried a copy of the
# same guard without that fallback, and so reported "no GPU" on every WSL2 host.
#
# These cases pin both halves: the WSL2 fallback must fire, and it must not
# weaken the AMD-only guard on non-WSL hosts.
#
# Run: bash tests/test-wsl2-gpu-detection.sh
# ============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0

# Source the script under test (detect_nvidia, is_wsl, first_line). The script
# guards its own main() with [[ "${BASH_SOURCE[0]}" == "$0" ]], so this is inert.
# shellcheck disable=SC1091
source "$SCRIPT_DIR/scripts/detect-hardware.sh"
set +e

assert_detects() {
    local label="$1" status="$2" output="$3"
    if [[ "$status" -eq 0 && -n "$output" ]]; then
        echo "  PASS: $label (detected '$output')"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: $label (expected detection, got status=$status output='$output')"
        FAIL=$((FAIL + 1))
    fi
}

assert_rejects() {
    local label="$1" status="$2" output="$3"
    if [[ "$status" -ne 0 ]]; then
        echo "  PASS: $label (correctly rejected)"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: $label (expected rejection, got status=0 output='$output')"
        FAIL=$((FAIL + 1))
    fi
}

# ----------------------------------------------------------------------------
# Fixtures
# ----------------------------------------------------------------------------
FIXTURE_DIR="$(mktemp -d -t ods-wsl2-fixture-XXXXXX)"
trap 'rm -rf "$FIXTURE_DIR"' EXIT

# WSL2 kernels carry "microsoft" in /proc/version; native kernels do not.
echo "Linux version 6.6.87.2-microsoft-standard-WSL2 (root@builder) #1 SMP" \
    > "$FIXTURE_DIR/proc-version-wsl"
echo "Linux version 6.8.0-51-generic (buildd@lcy02) #52-Ubuntu SMP" \
    > "$FIXTURE_DIR/proc-version-native"

# An empty DRM tree: what WSL2 actually presents (no card* entries at all).
mkdir -p "$FIXTURE_DIR/drm-empty"

# A bare-metal NVIDIA DRM tree.
mkdir -p "$FIXTURE_DIR/drm-nvidia/card0/device"
echo "0x10de" > "$FIXTURE_DIR/drm-nvidia/card0/device/vendor"

# An AMD-only DRM tree -- the case the sysfs guard was added to defend.
mkdir -p "$FIXTURE_DIR/drm-amd/card0/device"
echo "0x1002" > "$FIXTURE_DIR/drm-amd/card0/device/vendor"

# nvidia-smi stub answering only the query detect_nvidia() makes.
mkdir -p "$FIXTURE_DIR/bin"
cat > "$FIXTURE_DIR/bin/nvidia-smi" <<'STUB'
#!/usr/bin/env bash
echo "NVIDIA GeForce RTX 3060, 12288"
STUB
chmod +x "$FIXTURE_DIR/bin/nvidia-smi"

WITH_SMI="$FIXTURE_DIR/bin:$PATH"

# A PATH with every nvidia-smi-bearing directory removed, so "not installed"
# is simulated without assuming where the real binary lives.
path_without_nvidia_smi() {
    local out="" d
    local -a dirs
    IFS=':' read -ra dirs <<< "$PATH"
    for d in "${dirs[@]}"; do
        [[ -n "$d" && -x "$d/nvidia-smi" ]] && continue
        out="${out:+$out:}$d"
    done
    printf '%s' "$out"
}
WITHOUT_SMI="$(path_without_nvidia_smi)"

run_case() {
    # run_case <proc-version> <drm-tree> <path>
    local out
    out="$(ODS_PROC_VERSION="$1" ODS_DRM_SYS="$2" PATH="$3" detect_nvidia 2>/dev/null)"
    LAST_STATUS=$?
    LAST_OUTPUT="$out"
}

echo "=== detect_nvidia() on WSL2 (no sysfs DRM entries) ==="
echo ""

run_case "$FIXTURE_DIR/proc-version-wsl" "$FIXTURE_DIR/drm-empty" "$WITH_SMI"
assert_detects "WSL2 + nvidia-smi present -> GPU detected" "$LAST_STATUS" "$LAST_OUTPUT"

run_case "$FIXTURE_DIR/proc-version-wsl" "$FIXTURE_DIR/drm-empty" "$WITHOUT_SMI"
assert_rejects "WSL2 + no nvidia-smi -> no witness, no GPU" "$LAST_STATUS" "$LAST_OUTPUT"

echo ""
echo "=== the sysfs guard still holds on non-WSL hosts ==="
echo ""

run_case "$FIXTURE_DIR/proc-version-native" "$FIXTURE_DIR/drm-empty" "$WITH_SMI"
assert_rejects "native + nvidia-smi but no NVIDIA in sysfs -> rejected" "$LAST_STATUS" "$LAST_OUTPUT"

run_case "$FIXTURE_DIR/proc-version-native" "$FIXTURE_DIR/drm-amd" "$WITH_SMI"
assert_rejects "native AMD-only box with nvidia-container-toolkit -> rejected" "$LAST_STATUS" "$LAST_OUTPUT"

echo ""
echo "=== bare-metal NVIDIA detection is unchanged ==="
echo ""

run_case "$FIXTURE_DIR/proc-version-native" "$FIXTURE_DIR/drm-nvidia" "$WITH_SMI"
assert_detects "native + NVIDIA vendor 0x10de in sysfs -> GPU detected" "$LAST_STATUS" "$LAST_OUTPUT"

echo ""
echo "============================================================"
echo "  Passed: $PASS   Failed: $FAIL"
echo "============================================================"

[[ "$FAIL" -eq 0 ]]
