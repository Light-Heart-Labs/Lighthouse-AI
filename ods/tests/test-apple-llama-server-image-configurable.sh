#!/usr/bin/env bash
# ============================================================================
# ODS docker-compose.apple.yml — llama-server image configurability
# ============================================================================
# Every other GPU overlay (nvidia, cpu, intel, base) lets operators override
# the llama-server image via LLAMA_SERVER_IMAGE. docker-compose.apple.yml
# hardcoded it instead, so operators on Apple Silicon couldn't pin/swap the
# image without editing the compose file directly.
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APPLE_COMPOSE="$ROOT_DIR/docker-compose.apple.yml"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
PASS=0
FAIL=0

pass() { echo -e "  ${GREEN}PASS${NC} $1"; PASS=$((PASS + 1)); }
fail() { echo -e "  ${RED}FAIL${NC} $1"; FAIL=$((FAIL + 1)); }

echo ""
echo "=== docker-compose.apple.yml llama-server image tests ==="
echo ""

if grep -Fq 'image: ${LLAMA_SERVER_IMAGE:-ghcr.io/ggml-org/llama.cpp:server-b8248}' "$APPLE_COMPOSE"; then
    pass "llama-server image is overridable via LLAMA_SERVER_IMAGE with the original default preserved"
else
    fail "llama-server image is not using the \${LLAMA_SERVER_IMAGE:-...} pattern"
fi

if grep -Fxq 'image: ghcr.io/ggml-org/llama.cpp:server-b8248' "$APPLE_COMPOSE"; then
    fail "llama-server image is still hardcoded with no override mechanism (the bug)"
else
    pass "llama-server image is no longer hardcoded"
fi

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    RESOLVED_DEFAULT="$(WEBUI_SECRET=test-secret DASHBOARD_API_KEY=test-key \
        docker compose -f "$ROOT_DIR/docker-compose.base.yml" -f "$APPLE_COMPOSE" config 2>/dev/null \
        | grep -A0 "^    image: ghcr.io/ggml-org/llama.cpp" | head -n1 | sed 's/^ *image: //')"
    if [[ "$RESOLVED_DEFAULT" == "ghcr.io/ggml-org/llama.cpp:server-b8248" ]]; then
        pass "docker compose config resolves the default image unchanged when unset"
    else
        fail "docker compose config did not resolve the expected default image (got: '$RESOLVED_DEFAULT')"
    fi

    RESOLVED_OVERRIDE="$(WEBUI_SECRET=test-secret DASHBOARD_API_KEY=test-key LLAMA_SERVER_IMAGE="my-custom-image:tag" \
        docker compose -f "$ROOT_DIR/docker-compose.base.yml" -f "$APPLE_COMPOSE" config 2>/dev/null \
        | grep -F "my-custom-image:tag" | head -n1)"
    if [[ -n "$RESOLVED_OVERRIDE" ]]; then
        pass "docker compose config honors a LLAMA_SERVER_IMAGE override"
    else
        fail "docker compose config did not honor a LLAMA_SERVER_IMAGE override"
    fi
else
    echo "  SKIP: docker compose not available — skipping live config resolution checks"
fi

echo ""
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
