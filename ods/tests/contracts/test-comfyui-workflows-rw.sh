#!/usr/bin/env bash
# Test that ComfyUI workflows volume mount is read-write in all GPU overlay compose files

set -euo pipefail

# List of Compose files to check
compose_files=(
    "extensions/services/comfyui/compose.amd.yaml"
    "extensions/services/comfyui/compose.nvidia.yaml"
    "extensions/services/comfyui/compose.multigpu-amd.yaml"
    "extensions/services/comfyui/compose.multigpu-nvidia.yaml"
)

# Expected pattern for rw mount
expected_pattern="./data/comfyui/workflows:/workflows:rw,z"

failed=0
for file in "${compose_files[@]}"; do
    if [[ ! -f "$file" ]]; then
        echo "ERROR: File not found: $file"
        failed=$((failed + 1))
        continue
    fi
    if ! grep -q "$expected_pattern" "$file"; then
        echo "FAIL: $file does not have rw workflows mount"
        failed=$((failed + 1))
    fi
done

if (( failed > 0 )); then
    echo "FAILED: $failed file(s) do not have correct rw workflows mount"
    exit 1
else
    echo "PASS: All ComfyUI compose files have rw workflows mount"
    exit 0
fi