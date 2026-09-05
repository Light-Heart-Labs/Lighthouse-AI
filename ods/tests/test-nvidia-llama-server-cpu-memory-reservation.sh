#!/usr/bin/env bash
# ============================================================================
# ODS docker-compose.nvidia.yml — llama-server CPU/memory reservations
# ============================================================================
# Every overlay that overrides llama-server's deploy.resources (apple, cpu,
# intel) sets both limits AND reservations for cpus/memory. nvidia.yml only
# set limits — its reservations block had only the GPU `devices` entry, with
# no cpus/memory floor, unlike every sibling overlay.
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NVIDIA_COMPOSE="$ROOT_DIR/docker-compose.nvidia.yml"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
PASS=0
FAIL=0

pass() { echo -e "  ${GREEN}PASS${NC} $1"; PASS=$((PASS + 1)); }
fail() { echo -e "  ${RED}FAIL${NC} $1"; FAIL=$((FAIL + 1)); }

echo ""
echo "=== docker-compose.nvidia.yml llama-server reservation tests ==="
echo ""

LLAMA_BLOCK="$(awk '/^  llama-server:/{flag=1} /^  [a-z]/{if ($0 != "  llama-server:") flag=0} flag' "$NVIDIA_COMPOSE")"

if grep -Fq 'LLAMA_CPU_RESERVATION' <<< "$LLAMA_BLOCK" && grep -A5 'reservations:' <<< "$LLAMA_BLOCK" | grep -Fq 'memory: 4G'; then
    pass "llama-server declares a CPU and memory reservation"
else
    fail "llama-server is still missing CPU/memory reservations (the bug)"
fi

if grep -A10 'reservations:' <<< "$LLAMA_BLOCK" | grep -Fq 'driver: nvidia'; then
    pass "the existing GPU device reservation is preserved (no regression)"
else
    fail "the GPU device reservation was lost"
fi

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    RESOLVED="$(WEBUI_SECRET=test-secret DASHBOARD_API_KEY=test-key \
        docker compose -f "$ROOT_DIR/docker-compose.base.yml" -f "$NVIDIA_COMPOSE" config 2>/dev/null \
        | awk '/^  llama-server:/{flag=1} /^  [a-z]/{if ($0 != "  llama-server:") flag=0} flag')"
    if grep -A3 'reservations:' <<< "$RESOLVED" | grep -Fq 'cpus: 2' \
        && grep -A5 'reservations:' <<< "$RESOLVED" | grep -Fq '"4294967296"'; then
        pass "docker compose config resolves the default CPU/memory reservation (2 cpus, 4G)"
    else
        fail "docker compose config did not resolve the expected reservation defaults"
    fi
    if grep -A10 'reservations:' <<< "$RESOLVED" | grep -Fq 'driver: nvidia'; then
        pass "docker compose config still resolves the GPU device reservation"
    else
        fail "docker compose config lost the GPU device reservation"
    fi
else
    echo "  SKIP: docker compose not available — skipping live config resolution checks"
fi

echo ""
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
