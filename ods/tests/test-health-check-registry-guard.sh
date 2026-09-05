#!/usr/bin/env bash
# Regression: health-check must diagnose a failed service-registry load up
# front instead of dying later on an unguarded "${SERVICE_IDS[@]}" expansion
# ("unbound variable" under set -u on Bash < 4.4).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$ROOT_DIR/scripts/health-check.sh"

fail() {
    echo "[FAIL] $*" >&2
    exit 1
}

pass() {
    echo "[PASS] $*"
}

[[ -f "$TARGET" ]] || fail "missing $TARGET"

# Strip comments so explanatory text cannot satisfy or fail the checks.
active_code="$(grep -v '^[[:space:]]*#' "$TARGET")"

guard_line=$(grep -n '_SR_FAILED:-false' <<<"$active_code" | head -1 | cut -d: -f1)
[[ -n "$guard_line" ]] || fail "health-check has no service-registry failure guard"

expansion_line=$(grep -n '"${SERVICE_IDS\[@\]}"' <<<"$active_code" | head -1 | cut -d: -f1)
[[ -n "$expansion_line" ]] || fail "no SERVICE_IDS expansion found (test target moved?)"

(( guard_line < expansion_line )) \
    || fail "registry failure guard must run before the first SERVICE_IDS expansion"
pass "registry failure guard runs before the first SERVICE_IDS expansion"

grep -q 'pip3 install pyyaml' <<<"$active_code" \
    || fail "guard must tell the user how to fix the underlying cause"
pass "guard names the likely fix (install PyYAML)"
