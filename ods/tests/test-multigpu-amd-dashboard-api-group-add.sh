#!/usr/bin/env bash
# ============================================================================
# ODS docker-compose.multigpu-amd.yml — dashboard-api GPU device group_add
# ============================================================================
# dashboard-api gets /dev/kfd and /dev/dri added for multi-GPU monitoring,
# but without group_add (video/render group membership) a non-root
# container process can't actually read those device nodes — the same
# requirement llama-server already has via docker-compose.amd.yml's
# group_add. Without it, "Dashboard-api gets all GPUs for monitoring" (this
# file's own header comment) silently fails with permission errors.
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
echo "=== multigpu-amd dashboard-api group_add tests ==="
echo ""

# Extract just the dashboard-api service block for a targeted check.
DASHBOARD_BLOCK="$(awk '/^  dashboard-api:/{flag=1} /^  [a-z]/{if ($0 != "  dashboard-api:") flag=0} flag' "$MULTIGPU_AMD")"

if grep -Fq '/dev/kfd:/dev/kfd' <<< "$DASHBOARD_BLOCK" && grep -Fq '/dev/dri:/dev/dri' <<< "$DASHBOARD_BLOCK"; then
    pass "dashboard-api still requests /dev/kfd and /dev/dri (no regression)"
else
    fail "dashboard-api is missing the expected GPU device mounts"
fi

if grep -Fq 'group_add:' <<< "$DASHBOARD_BLOCK" && grep -Fq 'VIDEO_GID' <<< "$DASHBOARD_BLOCK" && grep -Fq 'RENDER_GID' <<< "$DASHBOARD_BLOCK"; then
    pass "dashboard-api sets group_add for the mounted GPU devices"
else
    fail "dashboard-api mounts GPU devices without group_add (the bug)"
fi

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    RESOLVED="$(WEBUI_SECRET=test-secret DASHBOARD_API_KEY=test-key \
        docker compose -f "$ROOT_DIR/docker-compose.base.yml" -f "$ROOT_DIR/docker-compose.amd.yml" -f "$MULTIGPU_AMD" \
        config 2>/dev/null | awk '/^  dashboard-api:/{flag=1} /^  [a-z]/{if ($0 != "  dashboard-api:") flag=0} flag')"
    if grep -A3 'group_add:' <<< "$RESOLVED" | grep -Fq '"44"' && grep -A3 'group_add:' <<< "$RESOLVED" | grep -Fq '"992"'; then
        pass "docker compose config resolves group_add to the expected default GIDs (44, 992)"
    else
        fail "docker compose config did not resolve the expected group_add defaults"
    fi
else
    echo "  SKIP: docker compose not available — skipping live config resolution check"
fi

echo ""
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
