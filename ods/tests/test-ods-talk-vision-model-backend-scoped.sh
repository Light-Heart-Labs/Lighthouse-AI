#!/usr/bin/env bash
# ============================================================================
# ODS docker-compose.base.yml / docker-compose.amd.yml — ODS_TALK_VISION_MODEL
# ============================================================================
# docker-compose.base.yml used to default ODS_TALK_VISION_MODEL to the
# Lemonade/AMD-specific "user.Qwen3.6-35B-A3B-Vision" model id for every
# backend. That naming convention only resolves on AMD/Lemonade hosts —
# NVIDIA/Apple/CPU/Intel users got a "model not found" error on any ODS Talk
# image attachment unless they manually overrode it. The default now lives
# only on the AMD overlay, where it belongs.
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
PASS=0
FAIL=0

pass() { echo -e "  ${GREEN}PASS${NC} $1"; PASS=$((PASS + 1)); }
fail() { echo -e "  ${RED}FAIL${NC} $1"; FAIL=$((FAIL + 1)); }

echo ""
echo "=== ODS_TALK_VISION_MODEL backend-scoping tests ==="
echo ""

if grep -Fq 'ODS_TALK_VISION_MODEL=${ODS_TALK_VISION_MODEL:-}' "$ROOT_DIR/docker-compose.base.yml"; then
    pass "base.yml no longer defaults to the Lemonade-specific model id"
else
    fail "base.yml still ships an AMD-specific default to every backend (the bug, or a regression)"
fi

if grep -Fq 'ODS_TALK_VISION_MODEL=${ODS_TALK_VISION_MODEL:-user.Qwen3.6-35B-A3B-Vision}' "$ROOT_DIR/docker-compose.amd.yml"; then
    pass "amd.yml restores the Lemonade-specific default for AMD hosts"
else
    fail "amd.yml no longer restores the Lemonade-specific default"
fi

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    BASE_ONLY="$(WEBUI_SECRET=test-secret DASHBOARD_API_KEY=test-key \
        docker compose -f "$ROOT_DIR/docker-compose.base.yml" config 2>/dev/null | grep 'ODS_TALK_VISION_MODEL')"
    if grep -Fq 'ODS_TALK_VISION_MODEL: ""' <<< "$BASE_ONLY"; then
        pass "docker compose config resolves ODS_TALK_VISION_MODEL to empty on base.yml alone"
    else
        fail "docker compose config did not resolve an empty default on base.yml alone (got: '$BASE_ONLY')"
    fi

    WITH_AMD="$(WEBUI_SECRET=test-secret DASHBOARD_API_KEY=test-key \
        docker compose -f "$ROOT_DIR/docker-compose.base.yml" -f "$ROOT_DIR/docker-compose.amd.yml" config 2>/dev/null \
        | grep 'ODS_TALK_VISION_MODEL')"
    if grep -Fq 'user.Qwen3.6-35B-A3B-Vision' <<< "$WITH_AMD"; then
        pass "docker compose config restores the Lemonade default when the AMD overlay is layered in"
    else
        fail "docker compose config did not restore the Lemonade default with the AMD overlay (got: '$WITH_AMD')"
    fi

    OVERRIDE="$(WEBUI_SECRET=test-secret DASHBOARD_API_KEY=test-key ODS_TALK_VISION_MODEL="my-custom-vision-model" \
        docker compose -f "$ROOT_DIR/docker-compose.base.yml" config 2>/dev/null | grep 'ODS_TALK_VISION_MODEL')"
    if grep -Fq 'my-custom-vision-model' <<< "$OVERRIDE"; then
        pass "operators can still override ODS_TALK_VISION_MODEL on non-AMD backends"
    else
        fail "an explicit ODS_TALK_VISION_MODEL override was not honored"
    fi
else
    echo "  SKIP: docker compose not available — skipping live config resolution checks"
fi

echo ""
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
