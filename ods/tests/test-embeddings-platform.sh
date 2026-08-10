#!/bin/bash
# ============================================================================
# Embeddings platform configurability test
# ============================================================================
# Regression for issue #2302: the bundled TEI embeddings service pinned
# `platform: linux/amd64`, forcing native arm64 hosts (Apple Silicon,
# Raspberry Pi, AWS Graviton) through slow QEMU emulation. The platform is now
# driven by EMBEDDINGS_PLATFORM (default linux/amd64) and registered in
# .env.schema.json + .env.example so validate-env CI stays green.
#
# Checks:
#   - compose.yaml reads platform from ${EMBEDDINGS_PLATFORM:-linux/amd64}
#   - .env.schema.json declares EMBEDDINGS_PLATFORM with the same default
#   - .env.example documents the variable
#   - (optional) docker compose config honors EMBEDDINGS_PLATFORM override
#
# Usage: ./tests/test-embeddings-platform.sh
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE="$ROOT_DIR/extensions/services/embeddings/compose.yaml"
SCHEMA="$ROOT_DIR/.env.schema.json"
ENV_EXAMPLE="$ROOT_DIR/.env.example"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASSED=0
FAILED=0

pass() { echo -e "  ${GREEN}✓ PASS${NC} $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "  ${RED}✗ FAIL${NC} $1"; FAILED=$((FAILED + 1)); }
skip() { echo -e "  ${YELLOW}⊘ SKIP${NC} $1"; }

echo ""
echo "╔═══════════════════════════════════════════════╗"
echo "║   Embeddings platform configurability test    ║"
echo "╚═══════════════════════════════════════════════╝"
echo ""

for f in "$COMPOSE" "$SCHEMA" "$ENV_EXAMPLE"; do
    if [[ ! -f "$f" ]]; then
        fail "missing file: $f"
        echo ""; echo "Result: $PASSED passed, $FAILED failed"; exit 1
    fi
done
pass "compose.yaml, .env.schema.json and .env.example all exist"

# --- 1. compose.yaml reads platform from EMBEDDINGS_PLATFORM -----------------
if grep -q 'platform: ${EMBEDDINGS_PLATFORM:-linux/amd64}' "$COMPOSE"; then
    pass "compose.yaml platform is driven by \${EMBEDDINGS_PLATFORM:-linux/amd64}"
else
    fail "compose.yaml must interpolate platform from \${EMBEDDINGS_PLATFORM:-linux/amd64}"
fi

if grep -q 'platform: linux/amd64  #' "$COMPOSE"; then
    fail "compose.yaml still hardcodes platform: linux/amd64"
else
    pass "compose.yaml no longer hardcodes the x86 platform"
fi

# --- 2. .env.schema.json declares EMBEDDINGS_PLATFORM ------------------------
if python3 -c '
import json, sys
schema = json.load(open(sys.argv[1]))
prop = schema.get("properties", {}).get("EMBEDDINGS_PLATFORM")
if not prop:
    sys.exit(1)
assert prop.get("type") == "string", "type must be string"
assert prop.get("default") == "linux/amd64", "default must be linux/amd64"
print(prop.get("description", ""))
' "$SCHEMA" > /dev/null 2>&1; then
    pass ".env.schema.json declares EMBEDDINGS_PLATFORM (string, default linux/amd64)"
else
    fail ".env.schema.json must declare EMBEDDINGS_PLATFORM with type string and default linux/amd64"
fi

# --- 3. .env.example documents the variable ----------------------------------
if grep -q 'EMBEDDINGS_PLATFORM=linux/amd64' "$ENV_EXAMPLE"; then
    pass ".env.example documents EMBEDDINGS_PLATFORM with its default"
else
    fail ".env.example should document EMBEDDINGS_PLATFORM=linux/amd64"
fi

# --- 4. Behavioral (optional): docker compose config honors the override -----
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    cd "$ROOT_DIR"
    rendered="$(EMBEDDINGS_PLATFORM=linux/arm64 docker compose \
        -f extensions/services/embeddings/compose.yaml config 2>/dev/null)"
    platform_line="$(printf '%s\n' "$rendered" | grep 'platform:')"
    if [[ "$platform_line" == *"linux/arm64"* ]]; then
        pass "docker compose config renders EMBEDDINGS_PLATFORM=linux/arm64"
    elif [[ "$platform_line" == *"linux/amd64"* ]]; then
        fail "docker compose config ignored the EMBEDDINGS_PLATFORM override"
    else
        skip "docker compose config output did not include a platform line"
    fi
else
    skip "Docker Compose unavailable; behavioral render skipped"
fi

echo ""
echo "Result: $PASSED passed, $FAILED failed"
[[ $FAILED -eq 0 ]] || exit 1
exit 0
