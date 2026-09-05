#!/bin/bash
# ============================================================================
# Test: scripts/mode-switch.sh's env_set() does not leak a stray .tmp file
#       (or silently continue) when the awk rewrite fails partway through.
# ============================================================================
# Regression for: env_set() piped awk's output straight to a fixed
# "${ENV_FILE}.tmp" path and only removed it via `&&`, so any awk failure
# (disk full, permission error, etc.) left the partial .tmp file on disk
# forever and the caller got no diagnostic.
# ============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MODE_SWITCH="$REPO_ROOT/scripts/mode-switch.sh"

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

extract_env_set() {
    sed -n '/^env_set() {/,/^}$/p' "$MODE_SWITCH"
}

TMP_DIR="$(mktemp -d)"
FAKE_BIN="$TMP_DIR/fakebin"
mkdir -p "$FAKE_BIN"
trap 'rm -rf "$TMP_DIR"' EXIT

# A fake `awk` that writes partial output then fails, simulating a
# mid-rewrite crash (disk full, permission revoked mid-write, etc.).
cat > "$FAKE_BIN/awk" << 'EOF'
#!/bin/sh
echo "PARTIAL_LINE_FROM_FAILED_AWK"
exit 1
EOF
chmod +x "$FAKE_BIN/awk"

ENV_SET_SRC="$(extract_env_set)"

run_env_set() {
    local env_file="$1" key="$2" val="$3" use_fake_awk="$4"
    (
        error() { echo "ERROR: $1" >&2; return 1; }
        ENV_FILE="$env_file"
        if [[ "$use_fake_awk" == "true" ]]; then
            PATH="$FAKE_BIN:$PATH"
        fi
        eval "$ENV_SET_SRC"
        env_set "$key" "$val"
    )
}

echo "== awk fails partway through the rewrite =="
ENV_FILE_FAIL="$TMP_DIR/fail.env"
cat > "$ENV_FILE_FAIL" << 'EOF'
ODS_MODE=local
OTHER_KEY=unrelated
EOF
run_env_set "$ENV_FILE_FAIL" "ODS_MODE" "cloud" "true"
RC=$?
check "env_set reports failure instead of continuing silently" "$RC" "1"
LEFTOVER_COUNT=$(find "$TMP_DIR" -maxdepth 1 -name 'fail.env.*' | wc -l | tr -d ' ')
check "no stray tmp file left behind after a failed rewrite" "$LEFTOVER_COUNT" "0"
check "original .env is untouched when the rewrite fails" "$(cat "$ENV_FILE_FAIL")" "$(printf 'ODS_MODE=local\nOTHER_KEY=unrelated')"

echo "== normal successful update (no regression) =="
ENV_FILE_OK="$TMP_DIR/ok.env"
cat > "$ENV_FILE_OK" << 'EOF'
ODS_MODE=local
OTHER_KEY=unrelated
EOF
run_env_set "$ENV_FILE_OK" "ODS_MODE" "cloud" "false"
RC_OK=$?
check "env_set succeeds on the normal path" "$RC_OK" "0"
check "key is actually updated" "$(grep '^ODS_MODE=' "$ENV_FILE_OK")" "ODS_MODE=cloud"
check "unrelated key is preserved" "$(grep '^OTHER_KEY=' "$ENV_FILE_OK")" "OTHER_KEY=unrelated"
LEFTOVER_OK=$(find "$TMP_DIR" -maxdepth 1 -name 'ok.env.*' | wc -l | tr -d ' ')
check "no stray tmp file left behind after a successful rewrite" "$LEFTOVER_OK" "0"

echo "== appending a brand-new key (no regression) =="
ENV_FILE_NEW="$TMP_DIR/new.env"
cat > "$ENV_FILE_NEW" << 'EOF'
ODS_MODE=local
EOF
run_env_set "$ENV_FILE_NEW" "BRAND_NEW_KEY" "value123" "false"
check "new key is appended" "$(grep '^BRAND_NEW_KEY=' "$ENV_FILE_NEW")" "BRAND_NEW_KEY=value123"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
