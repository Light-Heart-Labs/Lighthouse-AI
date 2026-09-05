#!/bin/bash
# ============================================================================
# Test: scripts/llm-cold-storage.sh's do_archive() does not report a failed
#       mv as a successful archive.
# ============================================================================
# Regression: this script runs under `set -uo pipefail` (no `-e`), and the
# real archive step was:
#     mv "$model_dir" "$COLD_DIR/$name"
#     ln -s "$COLD_DIR/$name" "${model_dir%/}"
#     log "ARCHIVED: $name -> $COLD_DIR/$name"
# with no exit-status check on either command. If `mv` failed (destination
# already exists as a non-empty directory, disk full, permission error,
# etc.), the script still unconditionally logged "ARCHIVED" and counted the
# model as archived, and would then create a symlink pointing at a
# nonexistent cold-storage path — corrupting the HF cache entry while
# leaving the model exactly where it was (no space freed at all).
#
# This runs the real script (both pre-fix via `git show HEAD` and the
# current one) as a subprocess against a forced mv failure: pre-creating a
# non-empty directory at the destination path, which makes `mv` fail
# deterministically regardless of privilege level.
# ============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CURRENT_SCRIPT="$REPO_ROOT/scripts/llm-cold-storage.sh"

command -v bc >/dev/null 2>&1 || { echo "SKIP: bc not available (required by get_last_access_days)"; exit 0; }

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

get_prefix_script() {
    local prefix
    prefix="$(cd "$REPO_ROOT" && git rev-parse --show-prefix)"
    (cd "$REPO_ROOT" && git show "HEAD:${prefix}scripts/llm-cold-storage.sh")
}

setup_fixture() {
    local base="$1"
    local hf_cache="$base/hf-cache"
    local cold_dir="$base/cold"
    local model_dir="$hf_cache/models--Fake--IdleModel"
    mkdir -p "$model_dir"
    echo "fake weights" > "$model_dir/model.bin"
    # Old atime so get_last_access_days reports well past MAX_IDLE_DAYS (7).
    touch -a -t 202001010000 "$model_dir/model.bin" "$model_dir"
    mkdir -p "$cold_dir"
    printf '%s\n' "$hf_cache" "$cold_dir"
}

# Force `mv "$model_dir" "$COLD_DIR/$name"` to fail: pre-create a plain
# *file* at the destination path. `mv` moving a directory onto an existing
# non-directory refuses ("cannot overwrite non-directory with directory"),
# deterministically and regardless of privilege level — unlike an existing
# directory target, which mv would just move the source inside instead.
force_mv_failure() {
    local cold_dir="$1"
    : > "$cold_dir/models--Fake--IdleModel"
}

echo "== Pre-fix script: mv destination pre-blocked =="
PREFIX_SCRIPT_SRC="$(get_prefix_script)"
PREFIX_SCRIPT_FILE="$TMP_DIR/prefix-llm-cold-storage.sh"
printf '%s\n' "$PREFIX_SCRIPT_SRC" > "$PREFIX_SCRIPT_FILE"
chmod +x "$PREFIX_SCRIPT_FILE"

mapfile -t PRE_FIXTURE < <(setup_fixture "$TMP_DIR/prefix-fixture")
PRE_HF_CACHE="${PRE_FIXTURE[0]}"
PRE_COLD_DIR="${PRE_FIXTURE[1]}"
force_mv_failure "$PRE_COLD_DIR"
PRE_LOG="$TMP_DIR/prefix.log"
HF_CACHE="$PRE_HF_CACHE" COLD_DIR="$PRE_COLD_DIR" LOG_FILE="$PRE_LOG" \
    bash "$PREFIX_SCRIPT_FILE" --execute > /dev/null 2>&1

check "pre-fix: log falsely claims ARCHIVED despite the blocked mv (the bug)" \
    "$(grep -c 'ARCHIVED: models--Fake--IdleModel ->' "$PRE_LOG" 2>/dev/null)" "1"
check "pre-fix: model directory was never actually moved out of HF_CACHE" \
    "$([[ -d "$PRE_HF_CACHE/models--Fake--IdleModel" && ! -L "$PRE_HF_CACHE/models--Fake--IdleModel" ]] && echo yes || echo no)" "yes"

echo "== Post-fix script: mv destination pre-blocked =="
mapfile -t POST_FIXTURE < <(setup_fixture "$TMP_DIR/postfix-fixture")
POST_HF_CACHE="${POST_FIXTURE[0]}"
POST_COLD_DIR="${POST_FIXTURE[1]}"
force_mv_failure "$POST_COLD_DIR"
POST_LOG="$TMP_DIR/postfix.log"
HF_CACHE="$POST_HF_CACHE" COLD_DIR="$POST_COLD_DIR" LOG_FILE="$POST_LOG" \
    bash "$CURRENT_SCRIPT" --execute > /dev/null 2>&1

check "post-fix: log reports an ERROR instead of a false ARCHIVED" \
    "$(grep -c 'ERROR: Failed to move models--Fake--IdleModel' "$POST_LOG" 2>/dev/null)" "1"
check "post-fix: no false ARCHIVED line for the blocked model" \
    "$(grep -c 'ARCHIVED: models--Fake--IdleModel ->' "$POST_LOG" 2>/dev/null)" "0"
check "post-fix: model directory is still a real directory in HF_CACHE, not touched" \
    "$([[ -d "$POST_HF_CACHE/models--Fake--IdleModel" && ! -L "$POST_HF_CACHE/models--Fake--IdleModel" ]] && echo yes || echo no)" "yes"

echo "== Post-fix script: normal successful archive (no regression) =="
mapfile -t OK_FIXTURE < <(setup_fixture "$TMP_DIR/ok-fixture")
OK_HF_CACHE="${OK_FIXTURE[0]}"
OK_COLD_DIR="${OK_FIXTURE[1]}"
OK_LOG="$TMP_DIR/ok.log"
HF_CACHE="$OK_HF_CACHE" COLD_DIR="$OK_COLD_DIR" LOG_FILE="$OK_LOG" \
    bash "$CURRENT_SCRIPT" --execute > /dev/null 2>&1

check "post-fix success path: ARCHIVED is logged" \
    "$(grep -c 'ARCHIVED: models--Fake--IdleModel ->' "$OK_LOG" 2>/dev/null || echo 0)" "1"
check "post-fix success path: model dir is now a symlink into cold storage" \
    "$([[ -L "$OK_HF_CACHE/models--Fake--IdleModel" ]] && echo yes || echo no)" "yes"
check "post-fix success path: cold storage actually holds the moved files" \
    "$([[ -f "$OK_COLD_DIR/models--Fake--IdleModel/model.bin" ]] && echo yes || echo no)" "yes"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
