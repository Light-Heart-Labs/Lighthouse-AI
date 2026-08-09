#!/bin/bash
# ============================================================================
# Workflow least-privilege permissions test
# ============================================================================
# Regression for issue #2300: several .github/workflows/*.yml had no top-level
# `permissions:` block, so GITHUB_TOKEN ran with repo-default (full write)
# privileges on every job. This test enforces the least-privilege contract:
#   - every workflow declares a top-level `permissions:` block, and
#   - no workflow grants `write-all` (the "everything write" shorthand).
#
# Any job that needs write access must declare it at job level explicitly;
# a blanket top-level write-all is never acceptable.
#
# Usage: ./tests/test-workflow-permissions.sh
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKFLOWS_DIR="$ROOT_DIR/../.github/workflows"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

PASSED=0
FAILED=0

pass() { echo -e "  ${GREEN}✓ PASS${NC} $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "  ${RED}✗ FAIL${NC} $1"; FAILED=$((FAILED + 1)); }

echo ""
echo "╔═══════════════════════════════════════════════╗"
echo "║   Workflow least-privilege permissions test   ║"
echo "╚═══════════════════════════════════════════════╝"
echo ""

if [[ ! -d "$WORKFLOWS_DIR" ]]; then
    fail ".github/workflows directory not found at $WORKFLOWS_DIR"
    echo ""; echo "Result: $PASSED passed, $FAILED failed"; exit 1
fi

shopt -s nullglob
workflow_files=("$WORKFLOWS_DIR"/*.yml)
shopt -u nullglob

if [[ ${#workflow_files[@]} -eq 0 ]]; then
    fail "no workflow YAML files found in $WORKFLOWS_DIR"
    echo ""; echo "Result: $PASSED passed, $FAILED failed"; exit 1
fi
pass "found ${#workflow_files[@]} workflow YAML files"

for wf in "${workflow_files[@]}"; do
    name="$(basename "$wf")"
    if grep -q '^permissions:' "$wf"; then
        pass "$name declares a top-level permissions block"
    else
        fail "$name is missing a top-level permissions block (GITHUB_TOKEN runs with default privileges)"
    fi

    if grep -q '^permissions: *write-all' "$wf"; then
        fail "$name grants write-all at the top level"
    else
        pass "$name does not grant write-all at the top level"
    fi
done

echo ""
echo "Result: $PASSED passed, $FAILED failed"
[[ $FAILED -eq 0 ]] || exit 1
exit 0
