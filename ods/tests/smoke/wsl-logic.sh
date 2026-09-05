#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "[smoke] WSL dispatch logic"
grep -q "linux|wsl" installers/dispatch.sh
grep -q "Windows (Docker Desktop + WSL2)" docs/SUPPORT-MATRIX.md
grep -q 'install\.ps1' docs/SUPPORT-MATRIX.md

echo "[smoke] WSL capability-profile NVIDIA detection"
# Source the production detector without executing main, then emulate the WSL
# kernel signal and its paravirtualized nvidia-smi surface. WSL commonly has no
# /sys/class/drm/card*/device/vendor entry, so nvidia-smi itself is the witness.
source scripts/detect-hardware.sh
is_wsl() { return 0; }
nvidia-smi() {
    case "$*" in
        *--query-gpu=name,memory.total*)
            printf '%s\n' 'NVIDIA GeForce RTX 4090, 24564'
            ;;
        *)
            return 1
            ;;
    esac
}
wsl_nvidia="$(detect_nvidia)"
[[ "$wsl_nvidia" == "NVIDIA GeForce RTX 4090, 24564" ]] || {
    echo "[smoke] WSL nvidia-smi was not accepted without PCI sysfs" >&2
    exit 1
}

# Presence of the executable is not enough: a stale/broken nvidia-smi must
# still fail so AMD and CPU detection can continue.
nvidia-smi() { return 1; }
if detect_nvidia >/dev/null; then
    echo "[smoke] failed WSL nvidia-smi was accepted as hardware" >&2
    exit 1
fi

echo "[smoke] PASS wsl-logic"
