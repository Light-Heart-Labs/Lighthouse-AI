#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKFLOW_DIR="$ROOT_DIR/.github/workflows"
checked=0

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

for workflow in "$WORKFLOW_DIR"/*.yml; do
    [[ -f "$workflow" ]] || continue
    grep -q '^permissions:$' "$workflow" \
        || fail "$(basename "$workflow") has no workflow-level permissions default"
    ! grep -qE '^permissions:[[:space:]]*write-all|^[[:space:]]+actions:[[:space:]]+write$' "$workflow" \
        || fail "$(basename "$workflow") grants an overbroad workflow-level permission"
    checked=$((checked + 1))
done

[[ "$checked" -gt 0 ]] || fail "no workflow files found"

issue_to_pr="$WORKFLOW_DIR/issue-to-pr.yml"
grep -q '^  pull-requests: read$' "$issue_to_pr" \
    || fail "issue-to-pr deduplication needs pull-request read access"
grep -q '^      issues: write$' "$issue_to_pr" \
    || fail "issue-to-pr creation job needs issue comment access"

nightly_docs="$WORKFLOW_DIR/nightly-docs-update.yml"
grep -q '^      contents: write$' "$nightly_docs" \
    || fail "nightly docs PR job needs scoped contents write access"
grep -q '^      pull-requests: write$' "$nightly_docs" \
    || fail "nightly docs PR job needs scoped pull-request write access"

echo "test-workflow-permissions: $checked workflows checked"
