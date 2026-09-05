#!/bin/bash
# ============================================================================
# Test: installers/phases/11-services.sh's _phase11_env_set() does not leak
#       a stray .tmp file (or continue silently) when the awk rewrite fails.
# ============================================================================
# Regression for: _phase11_env_set() piped awk's output to a fixed
# "${env_file}.tmp.$$" path and only removed it via a `&&` chain, so any awk
# failure (disk full, permission error, etc.) left the partial .tmp file on
# disk forever with no diagnostic — this runs during service startup, so a
# silently dropped GPU_BACKEND/ODS_MODE/LLM_API_URL write could leave the
# stack misconfigured.
# ============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PHASE_FILE="$REPO_ROOT/installers/phases/11-services.sh"

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

extract_phase11_env_set() {
    sed -n '/^    _phase11_env_set() {/,/^    }$/p' "$PHASE_FILE"
}

TMP_DIR="$(mktemp -d)"
FAKE_BIN="$TMP_DIR/fakebin"
mkdir -p "$FAKE_BIN"
trap 'rm -rf "$TMP_DIR"' EXIT

cat > "$FAKE_BIN/awk" << 'EOF'
#!/bin/sh
echo "PARTIAL_LINE_FROM_FAILED_AWK"
exit 1
EOF
chmod +x "$FAKE_BIN/awk"

ENV_SET_SRC="$(extract_phase11_env_set)"

run_env_set() {
    local install_dir="$1" key="$2" val="$3" use_fake_awk="$4"
    (
        error() { echo "ERROR: $1" >&2; return 1; }
        INSTALL_DIR="$install_dir"
        if [[ "$use_fake_awk" == "true" ]]; then
            PATH="$FAKE_BIN:$PATH"
        fi
        eval "$ENV_SET_SRC"
        _phase11_env_set "$key" "$val"
    )
}

echo "== awk fails partway through the rewrite =="
INSTALL_DIR_FAIL="$TMP_DIR/fail-install"
mkdir -p "$INSTALL_DIR_FAIL"
cat > "$INSTALL_DIR_FAIL/.env" << 'EOF'
GPU_BACKEND=nvidia
OTHER_KEY=unrelated
EOF
run_env_set "$INSTALL_DIR_FAIL" "GPU_BACKEND" "amd" "true"
RC=$?
check "_phase11_env_set reports failure instead of continuing silently" "$RC" "1"
LEFTOVER_COUNT=$(find "$INSTALL_DIR_FAIL" -maxdepth 1 -name '.env.*' | wc -l | tr -d ' ')
check "no stray tmp file left behind after a failed rewrite" "$LEFTOVER_COUNT" "0"
check "original .env is untouched when the rewrite fails" \
    "$(cat "$INSTALL_DIR_FAIL/.env")" "$(printf 'GPU_BACKEND=nvidia\nOTHER_KEY=unrelated')"

echo "== normal successful update (no regression) =="
INSTALL_DIR_OK="$TMP_DIR/ok-install"
mkdir -p "$INSTALL_DIR_OK"
cat > "$INSTALL_DIR_OK/.env" << 'EOF'
GPU_BACKEND=nvidia
OTHER_KEY=unrelated
EOF
run_env_set "$INSTALL_DIR_OK" "GPU_BACKEND" "amd" "false"
RC_OK=$?
check "_phase11_env_set succeeds on the normal path" "$RC_OK" "0"
check "key is actually updated" "$(grep '^GPU_BACKEND=' "$INSTALL_DIR_OK/.env")" "GPU_BACKEND=amd"
check "unrelated key is preserved" "$(grep '^OTHER_KEY=' "$INSTALL_DIR_OK/.env")" "OTHER_KEY=unrelated"
LEFTOVER_OK=$(find "$INSTALL_DIR_OK" -maxdepth 1 -name '.env.*' | wc -l | tr -d ' ')
check "no stray tmp file left behind after a successful rewrite" "$LEFTOVER_OK" "0"

echo "== appending a brand-new key (no regression) =="
INSTALL_DIR_NEW="$TMP_DIR/new-install"
mkdir -p "$INSTALL_DIR_NEW"
cat > "$INSTALL_DIR_NEW/.env" << 'EOF'
GPU_BACKEND=nvidia
EOF
run_env_set "$INSTALL_DIR_NEW" "BRAND_NEW_KEY" "value123" "false"
check "new key is appended" "$(grep '^BRAND_NEW_KEY=' "$INSTALL_DIR_NEW/.env")" "BRAND_NEW_KEY=value123"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
