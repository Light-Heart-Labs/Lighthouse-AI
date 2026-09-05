#!/bin/bash
# ============================================================================
# get-ods.sh install-dir removal guard test
# ============================================================================
# Regression for issue #2301: get-ods.sh removed an incomplete install with
# `rm -rf -- "$INSTALL_DIR"` where INSTALL_DIR comes from the environment
# verbatim. A typo like ODS_INSTALL_DIR=/ or an empty value resolved to the
# filesystem root or $HOME, and --force would destroy it unvalidated.
#
# assert_safe_install_dir must refuse:
#   - the filesystem root (/)
#   - $HOME itself
#   - the parent of $HOME
#   - any path that resolves outside $HOME
#   - a directory whose basename does not contain "ods"
#   - an *ods*-named directory with no ODS marker files
# and must accept a genuine ODS install dir (marker file present) inside $HOME.
#
# Strategy: extract the two guard functions verbatim from get-ods.sh so the
# test always reflects the shipped logic, then exercise them against a fake
# HOME with error() stubbed to record the refusal message.
#
# Usage: ./tests/test-get-ods-install-guard.sh
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
GET_ODS="$ROOT_DIR/get-ods.sh"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

PASSED=0
FAILED=0

pass() { echo -e "  ${GREEN}✓ PASS${NC} $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "  ${RED}✗ FAIL${NC} $1"; FAILED=$((FAILED + 1)); }

echo ""
echo "╔═══════════════════════════════════════════════╗"
echo "║   get-ods.sh install-dir removal guard test   ║"
echo "╚═══════════════════════════════════════════════╝"
echo ""

if [[ ! -f "$GET_ODS" ]]; then
    fail "get-ods.sh not found at $GET_ODS"
    echo ""; echo "Result: $PASSED passed, $FAILED failed"; exit 1
fi

# Extract _ods_install_has_marker and assert_safe_install_dir verbatim (from
# the _ods_install_has_marker definition up to, but not including,
# remove_install_dir).
FUNCS="$(
    awk '
        /^_ods_install_has_marker\(\) \{/ { in_funcs=1 }
        in_funcs && /^remove_install_dir\(\) \{/ { exit }
        in_funcs { print }
    ' "$GET_ODS"
)"
if [[ -z "$FUNCS" ]]; then
    fail "could not extract guard functions from get-ods.sh"
    echo ""; echo "Result: $PASSED passed, $FAILED failed"; exit 1
fi
pass "extracted guard functions from get-ods.sh"

# Stub error() to record the refusal and abort, then exercise the guard.
run_guard() {
    local target="$1"
    local home="$2"
    HOME="$home" TARGET="$target" LAST_ERROR="" bash -c '
        set -euo pipefail
        error() { LAST_ERROR="$1"; echo "REFUSED: $1"; exit 1; }
        '"$FUNCS"'
        if assert_safe_install_dir "$TARGET" 2>/dev/null; then
            echo "ACCEPTED"
        else
            echo "REFUSED"
        fi
    ' || true
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAKE_HOME="$TMP/home/user"
mkdir -p "$FAKE_HOME"

# A genuine ODS install dir: *ods* basename + a marker file.
GOOD_ODS="$FAKE_HOME/ods"
mkdir -p "$GOOD_ODS"
touch "$GOOD_ODS/.env"

# An *ods*-named dir with no markers (incomplete/foreign install).
EMPTY_ODS="$FAKE_HOME/someods"
mkdir -p "$EMPTY_ODS"

# An ods-looking dir that is actually a file (marker check requires -e, which
# matches files too, but assert_safe_install_dir resolves with pwd -P; keep a
# real dir without markers for the marker-negative case above and test a file
# only for the basename check separately).
NON_ODS_DIR="$FAKE_HOME/sandbox"
mkdir -p "$NON_ODS_DIR"

OUTSIDE="$TMP/outside"
mkdir -p "$OUTSIDE"

# --- 1. Accept a genuine ODS install dir inside HOME ------------------------
out="$(run_guard "$GOOD_ODS" "$FAKE_HOME")"
if [[ "$out" == "ACCEPTED" ]]; then
    pass "accepts a genuine ODS install dir inside HOME"
else
    fail "should accept a genuine ODS install dir (got: $out)"
fi

# --- 2. Refuse the filesystem root ------------------------------------------
out="$(run_guard "/" "$FAKE_HOME")"
if [[ "$out" == "REFUSED"* ]]; then
    pass "refuses the filesystem root (/)"
else
    fail "must refuse the filesystem root (got: $out)"
fi

# --- 3. Refuse $HOME itself ---------------------------------------------------
out="$(run_guard "$FAKE_HOME" "$FAKE_HOME")"
if [[ "$out" == "REFUSED"* ]]; then
    pass "refuses \$HOME itself"
else
    fail "must refuse \$HOME itself (got: $out)"
fi

# --- 4. Refuse the parent of $HOME -------------------------------------------
out="$(run_guard "$TMP/home" "$FAKE_HOME")"
if [[ "$out" == "REFUSED"* ]]; then
    pass "refuses the parent of \$HOME"
else
    fail "must refuse the parent of \$HOME (got: $out)"
fi

# --- 5. Refuse a path outside $HOME -------------------------------------------
out="$(run_guard "$OUTSIDE" "$FAKE_HOME")"
if [[ "$out" == "REFUSED"* ]]; then
    pass "refuses a resolved path outside \$HOME"
else
    fail "must refuse a path outside \$HOME (got: $out)"
fi

# --- 6. Refuse an *ods* dir with no marker files ------------------------------
out="$(run_guard "$EMPTY_ODS" "$FAKE_HOME")"
if [[ "$out" == "REFUSED"* ]]; then
    pass "refuses an *ods* directory with no ODS marker files"
else
    fail "must refuse a marker-less *ods* directory (got: $out)"
fi

echo ""
echo "Result: $PASSED passed, $FAILED failed"
[[ $FAILED -eq 0 ]] || exit 1
exit 0
