#!/bin/bash
# ============================================================================
# Test: installers/lib/background-tasks.sh's bg_task_start() does not follow
#       a pre-planted symlink at BG_TASK_REGISTRY to create/clobber an
#       arbitrary file.
# ============================================================================
# Regression for: BG_TASK_REGISTRY defaults to a predictable path under the
# shared, world-writable /tmp. bg_task_start() used to do:
#     if [[ ! -f "$BG_TASK_REGISTRY" ]]; then echo "[]" > "$BG_TASK_REGISTRY"; fi
# `-f` on a *dangling* symlink is false, so a local attacker who pre-plants
# a dangling symlink at that path could get the installer (often running as
# root) to create a new file at an attacker-chosen location — classic
# CWE-59/CWE-367 symlink race.
#
# This test extracts the registry-creation block from the real file (both
# pre-fix via `git show HEAD` and whatever is currently on disk) and runs
# each against a dangling symlink pointing outside the intended registry
# location, then checks whether the attacker-chosen target got created.
# ============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LIB_FILE="$REPO_ROOT/installers/lib/background-tasks.sh"

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

command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 not available"; exit 0; }

extract_current_block() {
    sed -n '/# Create registry if it doesn'"'"'t exist\./,/^    fi$/p' "$LIB_FILE"
}

extract_prefix_block() {
    local prefix
    prefix="$(cd "$REPO_ROOT" && git rev-parse --show-prefix)"
    (cd "$REPO_ROOT" && git show "HEAD:${prefix}installers/lib/background-tasks.sh") \
        | sed -n '/# Create registry if it doesn'"'"'t exist$/,/^    fi$/p'
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

run_block() {
    local block="$1" registry="$2"
    (
        BG_TASK_REGISTRY="$registry"
        eval "$block"
    )
}

echo "== Pre-fix block: dangling symlink escaping to an attacker-chosen path =="
mkdir -p "$TMP_DIR/prefix/victim-dir"
PREFIX_TARGET="$TMP_DIR/prefix/victim-dir/attacker-chosen-file.json"
PREFIX_REGISTRY="$TMP_DIR/prefix/registry.json"
ln -s "$PREFIX_TARGET" "$PREFIX_REGISTRY"
PREFIX_BLOCK="$(extract_prefix_block)"
run_block "$PREFIX_BLOCK" "$PREFIX_REGISTRY"
check "pre-fix: following the symlink creates the attacker-chosen file (the bug)" \
    "$([[ -e "$PREFIX_TARGET" ]] && echo yes || echo no)" "yes"

echo "== Post-fix block: same dangling symlink =="
mkdir -p "$TMP_DIR/postfix/victim-dir"
POST_TARGET="$TMP_DIR/postfix/victim-dir/attacker-chosen-file.json"
POST_REGISTRY="$TMP_DIR/postfix/registry.json"
ln -s "$POST_TARGET" "$POST_REGISTRY"
CURRENT_BLOCK="$(extract_current_block)"
run_block "$CURRENT_BLOCK" "$POST_REGISTRY"
check "post-fix: the symlink is never followed to create the attacker-chosen file" \
    "$([[ -e "$POST_TARGET" ]] && echo yes || echo no)" "no"

echo "== Post-fix block: normal case, no symlink involved =="
NORMAL_REGISTRY="$TMP_DIR/normal-registry.json"
run_block "$CURRENT_BLOCK" "$NORMAL_REGISTRY"
check "post-fix: a plain, non-existent path still gets created normally" \
    "$([[ -f "$NORMAL_REGISTRY" ]] && echo yes || echo no)" "yes"
check "post-fix: freshly created registry starts as an empty JSON array" \
    "$(cat "$NORMAL_REGISTRY")" "[]"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
