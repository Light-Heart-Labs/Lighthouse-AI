#!/usr/bin/env bash
# ============================================================================
# Test: scripts/pre-download.sh --tier <tier> runs unattended (closed stdin)
# ============================================================================
# Regression: download_tier()'s confirmation prompt
#
#     read -p "Continue? [Y/n] " -n 1 -r
#
# runs under `set -euo pipefail`. With stdin closed (a CI step, a pipe,
# nohup, </dev/null — anything without a terminal), `read` returns non-zero
# and `set -e` aborts the whole script at that line, before any download,
# with no message. This defeats the documented non-interactive invocation:
#
#     ./pre-download.sh --tier edge        # Download edge tier models
#
# The fix tolerates EOF on that one read (`read ... || REPLY=""`) so the
# existing `[[ $REPLY =~ ^[Nn]$ ]]` check proceeds on empty input — a tier
# chosen on the command line is explicit intent, and the prompt already
# defaults to yes. A piped "n" must still cancel.
#
# download_tier() also requires Bash 4 (associative array tier lookups) and,
# past the prompt, calls the real huggingface_hub API — a genuine network
# call. Neither is appropriate inside a fast, hermetic unit test, so this
# test isolates exactly the confirmation prompt from the shipped script (the
# only code path this bug touches) and drives it directly. This runs
# identically under Bash 3.2 and Bash 4+, unlike the script itself.
#
# Usage: bash tests/test-pre-download-tier-noninteractive.sh
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRE_DOWNLOAD="$SCRIPT_DIR/scripts/pre-download.sh"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

PASSED=0
FAILED=0
pass() { echo -e "${GREEN}✓${NC} $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "${RED}✗${NC} $1"; FAILED=$((FAILED + 1)); }
info() { echo -e "${BLUE}ℹ${NC} $1"; }

[[ -f "$PRE_DOWNLOAD" ]] || { echo "scripts/pre-download.sh not found"; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/ods-predl-noninteractive.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# ---------------------------------------------------------------------------
# Extract the confirmation prompt directly from the shipped script, so this
# test exercises the real source rather than a hand-copied stand-in and a
# future edit to the block cannot silently drift out of coverage.
# ---------------------------------------------------------------------------
start_line=$(grep -nF 'read -p "Continue? [Y/n] " -n 1 -r' "$PRE_DOWNLOAD" | head -1 | cut -d: -f1)
if [[ -z "$start_line" ]]; then
    fail "could not locate the 'Continue? [Y/n]' prompt in pre-download.sh"
    echo "Passed: $PASSED  Failed: $FAILED"
    exit 1
fi
# The block is exactly: the read, its `echo`, and the `if ... fi` that acts
# on $REPLY — six lines in the shipped file as of this writing.
fragment="$(sed -n "${start_line},$((start_line + 5))p" "$PRE_DOWNLOAD")"

if ! grep -q '^    fi$' <<<"$fragment"; then
    fail "extracted fragment does not end where expected; pre-download.sh may have changed shape"
    echo "--- fragment ---"
    echo "$fragment"
    echo "Passed: $PASSED  Failed: $FAILED"
    exit 1
fi

run_fragment() {
    # $1: stdin to feed the extracted read. Prints REACHED on the line after
    # the fragment iff it did not exit/abort — this is what "proceeded past
    # the confirmation" means, without ever touching a real download.
    bash -c "
        set -euo pipefail
        $fragment
        echo REACHED
    " <<<"$1"
}

run_fragment_closed_stdin() {
    bash -c "
        set -euo pipefail
        $fragment
        echo REACHED
    " < /dev/null
}

# ---------------------------------------------------------------------------
info "Closed stdin: the documented --tier invocation must not abort here"
# ---------------------------------------------------------------------------
out=""
rc=0
out="$(run_fragment_closed_stdin 2>&1)" || rc=$?

if [[ $rc -eq 0 ]]; then
    pass "exits 0 with stdin closed"
else
    fail "exited $rc with stdin closed (the documented --tier invocation would abort here)"
fi

if grep -q "REACHED" <<<"$out"; then
    pass "proceeds past the confirmation prompt with stdin closed"
else
    fail "never reached past the confirmation prompt with stdin closed"
fi

# ---------------------------------------------------------------------------
info "An explicit 'n' still cancels (the fix must not remove that check)"
# ---------------------------------------------------------------------------
out=""
rc=0
out="$(run_fragment "n" 2>&1)" || rc=$?

if grep -q "Cancelled." <<<"$out" && ! grep -q "REACHED" <<<"$out"; then
    pass "'n' cancels without reaching past the prompt"
else
    fail "'n' did not cancel as expected"
    echo "--- output ---"; echo "$out"
fi

# ---------------------------------------------------------------------------
info "An explicit 'y' still proceeds"
# ---------------------------------------------------------------------------
out=""
rc=0
out="$(run_fragment "y" 2>&1)" || rc=$?

if grep -q "REACHED" <<<"$out"; then
    pass "'y' proceeds"
else
    fail "'y' did not proceed"
fi

# ---------------------------------------------------------------------------
info "A bare Enter proceeds (documented default: [Y/n])"
# ---------------------------------------------------------------------------
out=""
rc=0
out="$(run_fragment "" 2>&1)" || rc=$?

if grep -q "REACHED" <<<"$out"; then
    pass "bare Enter proceeds"
else
    fail "bare Enter did not proceed"
fi

# ---------------------------------------------------------------------------
info "Source carries the EOF-tolerant idiom (guards against silent regression)"
# ---------------------------------------------------------------------------
prompt_line="$(sed -n "${start_line}p" "$PRE_DOWNLOAD")"
if grep -qE 'read -p "Continue\? \[Y/n\] " -n 1 -r \|\| REPLY=""' <<<"$prompt_line"; then
    pass "confirmation read tolerates EOF (|| REPLY=\"\")"
else
    fail "confirmation read no longer tolerates EOF — regression"
    echo "  actual: $prompt_line"
fi

echo ""
echo "Passed: $PASSED  Failed: $FAILED"
[[ $FAILED -eq 0 ]]
