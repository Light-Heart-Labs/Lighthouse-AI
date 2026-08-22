#!/usr/bin/env bash
# Regression checks for sudo credential priming during uninstall (#2623).
# Hermetic: stubs sudo/systemctl/docker/pgrep, fake HOME/INSTALL_DIR — no
# real systemd mutation, runs on Linux CI.
#
# Background: ods-uninstall.sh's first sudo call was
# `timeout 20s sudo systemctl disable --now ods-host-agent.service`. If
# `timeout` signals sudo while it's still reading the password (slow
# typing, or systemctl itself running long), sudo can be killed before it
# restores the terminal's echo setting, and the reported symptom was the
# sudo password appearing in plaintext. The fix primes the sudo credential
# cache with a clean, unwrapped `sudo -v` before any timeout-wrapped call.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$ROOT_DIR/ods-uninstall.sh"
TMP_DIR=""

fail() {
    echo "[FAIL] $*" >&2
    exit 1
}

pass() {
    echo "[PASS] $*"
}

make_stub_bin() {
    local stub_dir="$1"
    local sudo_log="$2"
    local sudo_v_exit="${3:-0}"

    cat > "$stub_dir/docker" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
    cat > "$stub_dir/pgrep" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
    cat > "$stub_dir/uname" <<'EOF'
#!/usr/bin/env bash
echo Linux
EOF
    cat > "$stub_dir/systemctl" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "is-enabled" ]]; then
    exit 0
fi
exit 0
EOF
    # Logs every invocation. `sudo -v` exits with SUDO_V_EXIT (simulating
    # auth success/failure); every other sudo call succeeds.
    cat > "$stub_dir/sudo" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "${sudo_log}"
if [[ "\${1:-}" == "-v" ]]; then
    exit ${sudo_v_exit}
fi
exit 0
EOF
    chmod +x "$stub_dir"/*
}

make_install() {
    local install_dir="$1"

    mkdir -p "$install_dir/lib"
    cp "$TARGET" "$install_dir/ods-uninstall.sh"
    cp "$ROOT_DIR/lib/safe-env.sh" "$install_dir/lib/safe-env.sh"
    touch "$install_dir/ods-cli"
}

run_uninstall() {
    local install_dir="$1"
    local home_dir="$2"
    local stub_dir="$3"
    local out_file="$4"

    HOME="$home_dir" \
    INSTALL_DIR="$install_dir" \
    PATH="$stub_dir:$PATH" \
        bash "$install_dir/ods-uninstall.sh" --force > "$out_file" 2>&1
}

main() {
    [[ -f "$TARGET" ]] || fail "missing $TARGET"

    TMP_DIR="$(mktemp -d -t ods-uninstall-sudo-test-XXXXXX)"
    trap 'rm -rf "$TMP_DIR"' EXIT

    # ── Scenario 1: sudo -v primes the cache before the first timeout-wrapped call ──
    local install1="$TMP_DIR/install1" home1="$TMP_DIR/home1" stub1="$TMP_DIR/bin1"
    make_install "$install1"
    mkdir -p "$home1" "$stub1"
    local sudo_log1="$TMP_DIR/sudo1.log"
    : > "$sudo_log1"
    make_stub_bin "$stub1" "$sudo_log1" 0
    run_uninstall "$install1" "$home1" "$stub1" "$TMP_DIR/out1.log" \
        || fail "uninstall must succeed when sudo authenticates cleanly"

    first_call="$(head -1 "$sudo_log1")"
    [[ "$first_call" == "-v" ]] \
        || fail "the first sudo invocation must be 'sudo -v' (got: '$first_call')"
    grep -qF "systemctl disable --now ods-host-agent.service" "$sudo_log1" \
        || fail "uninstall must still call sudo systemctl disable --now after priming"
    pass "sudo -v primes the credential cache before the first timeout-wrapped sudo call"

    # ── Scenario 2: sudo -v failing (no auth) must not abort the uninstall ──
    local install2="$TMP_DIR/install2" home2="$TMP_DIR/home2" stub2="$TMP_DIR/bin2"
    make_install "$install2"
    mkdir -p "$home2" "$stub2"
    local sudo_log2="$TMP_DIR/sudo2.log"
    : > "$sudo_log2"
    make_stub_bin "$stub2" "$sudo_log2" 1
    run_uninstall "$install2" "$home2" "$stub2" "$TMP_DIR/out2.log" \
        || fail "a failed sudo -v must not abort the whole uninstall (set -euo pipefail trap)"
    grep -qi "sudo authentication failed" "$TMP_DIR/out2.log" \
        || fail "a failed sudo -v must produce a warning"
    pass "a failed sudo -v warns and lets the uninstall continue"
}

main "$@"
