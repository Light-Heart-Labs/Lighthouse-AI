#!/bin/bash
# Regression (#2298): docker-compose.multigpu-nvidia.yml used to default
# NVIDIA_VISIBLE_DEVICES to "all" when LLAMA_SERVER_GPU_UUIDS was unset
# (manual compose runs, or the transient window during `ods gpu-reassign`
# which explicitly unsets it) — silently handing llama-server every GPU on
# the host instead of the assigned subset. This overlay is only merged in
# when gpu_count > 1 (scripts/resolve-compose-stack.sh), so the var must
# always be set whenever this file is actually part of the stack; failing
# closed is correct, not overly strict.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; exit 1; }

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    echo "  (skipped — docker compose not available)"
    exit 0
fi

TMPDIR_TEST="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_TEST"' EXIT

# Minimal env satisfying every other required variable in the base stack,
# so any failure below is unambiguously about LLAMA_SERVER_GPU_UUIDS.
cat > "$TMPDIR_TEST/compose-test.env" << 'MINENV'
LLM_MODEL=test
GGUF_FILE=test.gguf
MAX_CONTEXT=4096
GPU_BACKEND=nvidia
WEBUI_PORT=3000
WEBUI_SECRET=test
OLLAMA_PORT=11434
WHISPER_PORT=9000
TTS_PORT=8880
N8N_PORT=5678
QDRANT_PORT=6333
QDRANT_GRPC_PORT=6334
QDRANT_API_KEY=test
LITELLM_PORT=4000
LITELLM_KEY=test
OPENCLAW_PORT=7860
OPENCLAW_TOKEN=test
SEARXNG_PORT=8888
DASHBOARD_API_KEY=test
LIVEKIT_API_KEY=test
LIVEKIT_API_SECRET=test
OPENCODE_SERVER_PASSWORD=test
OPENCODE_PORT=3003
N8N_USER=admin
N8N_PASS=test
N8N_HOST=localhost
N8N_WEBHOOK_URL=http://localhost:5678
WEBUI_AUTH=true
ENABLE_WEB_SEARCH=true
WEB_SEARCH_ENGINE=searxng
WHISPER_MODEL=base
TTS_VOICE=en_US-lessac-medium
TIMEZONE=UTC
ODS_MODE=local
LLM_API_URL=http://llama-server:8080/v1
CTX_SIZE=4096
LANGFUSE_PORT=3006
LANGFUSE_ENABLED=false
LANGFUSE_NEXTAUTH_SECRET=test
LANGFUSE_SALT=test
LANGFUSE_ENCRYPTION_KEY=test
LANGFUSE_DB_PASSWORD=test
LANGFUSE_CLICKHOUSE_PASSWORD=test
LANGFUSE_REDIS_PASSWORD=test
LANGFUSE_MINIO_ACCESS_KEY=test
LANGFUSE_MINIO_SECRET_KEY=test
LANGFUSE_PROJECT_PUBLIC_KEY=test
LANGFUSE_PROJECT_SECRET_KEY=test
LANGFUSE_INIT_PROJECT_ID=test
LANGFUSE_INIT_USER_EMAIL=test@test.com
LANGFUSE_INIT_USER_PASSWORD=test
MINENV

COMPOSE_ARGS=(--env-file "$TMPDIR_TEST/compose-test.env" -f docker-compose.base.yml -f docker-compose.nvidia.yml -f docker-compose.multigpu-nvidia.yml)

echo "── multigpu-nvidia GPU isolation ──"

# Unset LLAMA_SERVER_GPU_UUIDS must fail closed, not default to "all".
unset LLAMA_SERVER_GPU_UUIDS 2>/dev/null || true
error_output="$(docker compose "${COMPOSE_ARGS[@]}" config --quiet 2>&1)" && rc=0 || rc=$?
if [[ "$rc" -eq 0 ]]; then
    fail "compose config succeeded with LLAMA_SERVER_GPU_UUIDS unset (should fail closed)"
elif ! echo "$error_output" | grep -q "LLAMA_SERVER_GPU_UUIDS"; then
    fail "compose config failed for an unrelated reason: $error_output"
else
    pass "compose config refuses to start with LLAMA_SERVER_GPU_UUIDS unset"
fi

# A set value must be passed through exactly — never silently widened to "all".
rendered="$(LLAMA_SERVER_GPU_UUIDS="GPU-aaa,GPU-bbb" docker compose "${COMPOSE_ARGS[@]}" config 2>/dev/null | grep 'NVIDIA_VISIBLE_DEVICES:')"
if [[ "$rendered" == *"GPU-aaa,GPU-bbb"* ]]; then
    pass "compose config passes through the assigned GPU UUIDs"
else
    fail "compose config did not render the assigned GPU UUIDs (got: $rendered)"
fi
if [[ "$rendered" == *": all"* ]]; then
    fail "compose config resolved NVIDIA_VISIBLE_DEVICES to 'all' despite an explicit assignment"
fi

echo ""
echo "  All checks passed"
