#!/bin/bash
# ============================================================================
# Test: write_compose_failure_report() does not claim success when the
#       report file was never actually written.
# ============================================================================
# Regression: this function always runs as the first stage of a pipeline at
# every call site (`write_compose_failure_report ... | tail -n 1`). Bash's
# `set -e` is suspended for every command in a pipeline except the last, so
# when `{ ...report body... } > "$report" 2>&1` failed to open $report (e.g.
# install_dir unwritable/nonexistent), the function did NOT abort — it fell
# through to unconditionally printing "Compose failure report saved: $report"
# and echoing that path back to the caller, even though nothing was written.
#
# This test sources the real library (both pre-fix via `git show HEAD` and
# the current file) and calls write_compose_failure_report with an
# install_dir that cannot be created, exactly as it's called at every real
# call site: as the first stage of a pipeline.
# ============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LIB_FILE="$REPO_ROOT/installers/lib/compose-failure-report.sh"

PASS=0
FAIL=0

check() {
    local desc="$1" actual="$2" expected="$3"
    if [[ "$actual" == "$expected" ]]; then
        echo "  PASS: $desc"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: $desc (expected '$expected', got '$actual')"
        FAIL=$((FAIL + 1))
    fi
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

get_prefix_lib() {
    local prefix
    prefix="$(cd "$REPO_ROOT" && git rev-parse --show-prefix)"
    (cd "$REPO_ROOT" && git show "HEAD:${prefix}installers/lib/compose-failure-report.sh")
}

run_with_lib() {
    local lib_src="$1" install_dir="$2"
    (
        eval "$lib_src"
        # Make $install_dir itself a file, not a directory — mkdir -p on it
        # fails (already swallowed via `2>/dev/null || true`), and the
        # subsequent report redirection then fails to open too, since a
        # path component is a regular file, not a directory.
        write_compose_failure_report \
            "$install_dir" \
            "test phase" \
            "docker compose up" \
            "" \
            "unknown" \
            "next step" | tail -n 1
    )
}

echo "== Pre-fix library: install_dir cannot be created =="
BLOCKED_PATH_PRE="$TMP_DIR/blocked-pre"
: > "$BLOCKED_PATH_PRE"   # a plain file where the "directory" should be
PREFIX_LIB="$(get_prefix_lib)"
PREFIX_OUTPUT="$(run_with_lib "$PREFIX_LIB" "$BLOCKED_PATH_PRE/subdir")"
check "pre-fix: claims a report path even though nothing was written (the bug)" \
    "$([[ -n "$PREFIX_OUTPUT" ]] && echo yes || echo no)" "yes"
check "pre-fix: the claimed report path does not actually exist" \
    "$([[ -f "$PREFIX_OUTPUT" ]] && echo yes || echo no)" "no"

echo "== Post-fix library: install_dir cannot be created =="
BLOCKED_PATH_POST="$TMP_DIR/blocked-post"
: > "$BLOCKED_PATH_POST"
CURRENT_LIB="$(cat "$LIB_FILE")"
POST_OUTPUT="$(run_with_lib "$CURRENT_LIB" "$BLOCKED_PATH_POST/subdir")"
check "post-fix: no report path is emitted when nothing was written" \
    "$([[ -z "$POST_OUTPUT" ]] && echo yes || echo no)" "yes"

echo "== Post-fix library: normal writable install_dir still works =="
OK_INSTALL_DIR="$TMP_DIR/ok-install"
OK_OUTPUT="$(run_with_lib "$CURRENT_LIB" "$OK_INSTALL_DIR")"
check "post-fix: a real report path is emitted on the success path" \
    "$([[ -n "$OK_OUTPUT" ]] && echo yes || echo no)" "yes"
check "post-fix: the emitted report path actually exists and is non-empty" \
    "$([[ -s "$OK_OUTPUT" ]] && echo yes || echo no)" "yes"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
