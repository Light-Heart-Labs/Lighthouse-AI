#!/usr/bin/env bash
# Regression check: ods-uninstall.sh must refuse to delete an ODS *source
# checkout*. The install-dir auto-detect keys off ods-cli, which the git repo
# ships too, so running the uninstaller (especially with --force) from a
# development clone would rm -rf the working tree. A deployed install always
# carries an installer-generated .env at its root; a git working tree without it
# is a source checkout and must be refused.

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

# Minimal stubs so the "allow" case can complete a full uninstall without
# touching the real system. git is intentionally NOT stubbed — the guard relies
# on the real binary, and prepending this dir to PATH leaves git reachable.
make_stub_bin() {
    local stub_dir="$1"
    local tool
    for tool in docker systemctl sudo pgrep; do
        cat > "$stub_dir/$tool" <<'EOF'
#!/usr/bin/env bash
# is-enabled / pgrep must report "nothing found" so the caller skips cleanup.
case "${1:-}" in
    is-enabled) exit 1 ;;
esac
exit 1
EOF
        chmod +x "$stub_dir/$tool"
    done
    # sudo must exec its argument (chown/rm), not exit 1.
    cat > "$stub_dir/sudo" <<'EOF'
#!/usr/bin/env bash
exec "$@"
EOF
    chmod +x "$stub_dir/sudo"
}

# Lay out a directory that looks like whatever `ods-uninstall.sh` keys off:
# a git working tree containing ods-cli and the uninstaller itself.
make_checkout() {
    local dir="$1"
    mkdir -p "$dir/lib"
    cp "$TARGET" "$dir/ods-uninstall.sh"
    cp "$ROOT_DIR/lib/safe-env.sh" "$dir/lib/safe-env.sh"
    touch "$dir/ods-cli"
    git -C "$dir" init -q
}

main() {
    [[ -f "$TARGET" ]] || fail "missing $TARGET"

    TMP_DIR="$(mktemp -d -t ods-uninstall-guard-XXXXXX)"
    trap 'rm -rf "$TMP_DIR"' EXIT

    local stub_dir="$TMP_DIR/bin"
    mkdir -p "$stub_dir"
    make_stub_bin "$stub_dir"

    # --- Case 1: source checkout (git tree, no .env) must be refused ---
    local checkout="$TMP_DIR/checkout"
    make_checkout "$checkout"

    local out status
    set +e
    out="$(HOME="$TMP_DIR/home1" PATH="$stub_dir:$PATH" \
        bash "$checkout/ods-uninstall.sh" --force 2>&1)"
    status=$?
    set -e

    (( status != 0 )) || fail "uninstall must exit non-zero for a source checkout"
    grep -qF 'Refusing to uninstall' <<<"$out" \
        || fail "uninstall must print a refusal for a source checkout; got: $out"
    [[ -d "$checkout" && -f "$checkout/ods-cli" ]] \
        || fail "uninstall must NOT delete the source checkout"
    pass "refuses to uninstall a git checkout with no installer .env"

    # --- Case 2: real install (has .env) must NOT be blocked by the guard ---
    local install="$TMP_DIR/install"
    make_checkout "$install"                       # git tree ...
    printf '%s\n' 'GPU_BACKEND=cpu' > "$install/.env"  # ... but a real install

    set +e
    out="$(HOME="$TMP_DIR/home2" PATH="$stub_dir:$PATH" \
        bash "$install/ods-uninstall.sh" --force 2>&1)"
    status=$?
    set -e

    if grep -qF 'Refusing to uninstall' <<<"$out"; then
        fail "guard must not fire for an install carrying a .env; got: $out"
    fi
    (( status == 0 )) || fail "uninstall of a real install should succeed; got exit $status: $out"
    pass "allows uninstall of a git checkout that carries an installer .env"

    echo "[OK] source-checkout guard regression checks passed"
}

main "$@"
