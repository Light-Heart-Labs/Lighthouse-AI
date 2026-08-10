#!/bin/bash
# ============================================================================
# claude-review.yml PR-head checkout test
# ============================================================================
# Regression for a subtle CI bug: on issue_comment events github.ref points at
# the default branch and github.base_ref is empty, so the checkout fetched
# main and the review silently reviewed main instead of the PR head.
#
# The workflow must:
#   - check out the PR merge ref (refs/pull/N/merge) on issue_comment events
#     via the checkout `ref:` expression, and
#   - use HEAD^...HEAD for the size check on issue_comment (where base_ref is
#     empty), keeping origin/<base>...HEAD for pull_request events.
#
# Usage: ./tests/test-claude-review-pr-ref.sh
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKFLOW="$ROOT_DIR/../.github/workflows/claude-review.yml"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

PASSED=0
FAILED=0

pass() { echo -e "  ${GREEN}✓ PASS${NC} $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "  ${RED}✗ FAIL${NC} $1"; FAILED=$((FAILED + 1)); }

echo ""
echo "╔═══════════════════════════════════════════════╗"
echo "║   claude-review.yml PR-head checkout test     ║"
echo "╚═══════════════════════════════════════════════╝"
echo ""

if [[ ! -f "$WORKFLOW" ]]; then
    fail "claude-review.yml not found at $WORKFLOW"
    echo ""; echo "Result: $PASSED passed, $FAILED failed"; exit 1
fi
pass "claude-review.yml exists"

# --- 1. issue_comment path checks out the PR merge ref ------------------------
if grep -q "format('refs/pull/{0}/merge', github.event.issue.number)" "$WORKFLOW"; then
    pass "checkout ref resolves the PR merge ref on issue_comment events"
else
    fail "checkout must use format('refs/pull/{0}/merge', github.event.issue.number) on issue_comment"
fi

if grep -q "ref: \${{ github.event_name == 'issue_comment' && format('refs/pull/{0}/merge', github.event.issue.number) || '' }}" "$WORKFLOW"; then
    pass "checkout ref is conditional on issue_comment and empty otherwise"
else
    fail "checkout ref must be conditional: refs/pull/N/merge on issue_comment, '' otherwise"
fi

# --- 2. Size check uses HEAD^...HEAD on issue_comment, base diff otherwise -----
if grep -q 'DIFF_ARGS="HEAD^...HEAD"' "$WORKFLOW"; then
    pass "issue_comment path diffs HEAD^...HEAD for the PR size check"
else
    fail "issue_comment path must set DIFF_ARGS=HEAD^...HEAD"
fi

if grep -q 'DIFF_ARGS="origin/\${BASE_REF}...HEAD"' "$WORKFLOW"; then
    pass "pull_request path still diffs against origin/\${BASE_REF}...HEAD"
else
    fail "pull_request path must keep DIFF_ARGS=origin/\${BASE_REF}...HEAD"
fi

# --- 3. The two branches are keyed on github.event_name ------------------------
if grep -q 'if \[ "\${{ github.event_name }}" == "issue_comment" \]; then' "$WORKFLOW"; then
    pass "diff-arg selection branches on github.event_name"
else
    fail "diff-arg selection must branch on github.event_name == issue_comment"
fi

echo ""
echo "Result: $PASSED passed, $FAILED failed"
[[ $FAILED -eq 0 ]] || exit 1
exit 0
