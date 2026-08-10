#!/usr/bin/env bash
# ============================================================================
# ODS docker-compose.multigpu-amd.yml — llama-server ROCR_VISIBLE_DEVICES
# default
# ============================================================================
# Every sibling multigpu-amd service (comfyui, embeddings, whisper) defaults
# its ROCR_VISIBLE_DEVICES-driving var to "0" — a safe, always-valid GPU
# index — if unset. llama-server defaulted LLAMA_SERVER_GPU_INDICES (which
# feeds ROCR_VISIBLE_DEVICES) to an empty string instead. An explicitly
# empty ROCR_VISIBLE_DEVICES means "zero GPUs visible" to ROCm, not "all
# GPUs" — so if the installer's GPU assignment computation ever failed to
# populate LLAMA_SERVER_GPU_INDICES, llama-server would silently lose GPU
# acceleration entirely, worse than every sibling service's fail-safe.
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MULTIGPU_AMD="$ROOT_DIR/docker-compose.multigpu-amd.yml"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
PASS=0
FAIL=0

pass() { echo -e "  ${GREEN}PASS${NC} $1"; PASS=$((PASS + 1)); }
fail() { echo -e "  ${RED}FAIL${NC} $1"; FAIL=$((FAIL + 1)); }

echo ""
echo "=== multigpu-amd llama-server ROCR_VISIBLE_DEVICES default tests ==="
echo ""

if grep -Fq 'ROCR_VISIBLE_DEVICES: "${LLAMA_SERVER_GPU_INDICES:-0}"' "$MULTIGPU_AMD"; then
    pass "llama-server defaults ROCR_VISIBLE_DEVICES to GPU 0, matching sibling services"
else
    fail "llama-server does not default ROCR_VISIBLE_DEVICES to \"0\" (the bug, or a regression)"
fi

if grep -Fq 'ROCR_VISIBLE_DEVICES: "${LLAMA_SERVER_GPU_INDICES:-}"' "$MULTIGPU_AMD"; then
    fail "llama-server still defaults ROCR_VISIBLE_DEVICES to an empty string (the bug)"
else
    pass "llama-server no longer defaults ROCR_VISIBLE_DEVICES to an empty string"
fi

for sibling in \
    "extensions/services/comfyui/compose.multigpu-amd.yaml:COMFYUI_GPU_INDEX" \
    "extensions/services/embeddings/compose.multigpu-amd.yaml:EMBEDDINGS_GPU_INDEX" \
    "extensions/services/whisper/compose.multigpu-amd.yaml:WHISPER_GPU_INDEX"; do
    file="${sibling%%:*}"
    var="${sibling##*:}"
    if grep -Fq "ROCR_VISIBLE_DEVICES: \"\${${var}:-0}\"" "$ROOT_DIR/$file"; then
        pass "sibling $file still defaults to GPU 0 (confirms the convention being matched)"
    else
        fail "sibling $file no longer defaults to GPU 0 — convention check is stale"
    fi
done

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    RESOLVED_DEFAULT="$(WEBUI_SECRET=test-secret DASHBOARD_API_KEY=test-key \
        docker compose -f "$ROOT_DIR/docker-compose.base.yml" -f "$ROOT_DIR/docker-compose.amd.yml" -f "$MULTIGPU_AMD" \
        config 2>/dev/null | sed -n '/^  llama-server:/,/^  [a-z]/p' | grep -i 'ROCR_VISIBLE_DEVICES')"
    if grep -Fq '"0"' <<< "$RESOLVED_DEFAULT"; then
        pass "docker compose config resolves ROCR_VISIBLE_DEVICES to \"0\" when unset"
    else
        fail "docker compose config did not resolve the expected default (got: '$RESOLVED_DEFAULT')"
    fi

    RESOLVED_OVERRIDE="$(WEBUI_SECRET=test-secret DASHBOARD_API_KEY=test-key LLAMA_SERVER_GPU_INDICES="0,1,2" \
        docker compose -f "$ROOT_DIR/docker-compose.base.yml" -f "$ROOT_DIR/docker-compose.amd.yml" -f "$MULTIGPU_AMD" \
        config 2>/dev/null | sed -n '/^  llama-server:/,/^  [a-z]/p' | grep -i 'ROCR_VISIBLE_DEVICES')"
    if grep -Fq '0,1,2' <<< "$RESOLVED_OVERRIDE"; then
        pass "docker compose config still honors a real multi-GPU assignment"
    else
        fail "docker compose config did not honor a LLAMA_SERVER_GPU_INDICES override"
    fi
else
    echo "  SKIP: docker compose not available — skipping live config resolution checks"
fi

echo ""
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
