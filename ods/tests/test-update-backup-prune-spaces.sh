#!/usr/bin/env bash
# ============================================================================
# Test: ods-update.sh backup retention on paths containing spaces
# ============================================================================
# Regression: cmd_backup pruned with
#
#     backup_dirs=$(find "$BACKUP_DIR" ... )
#     for dir in $backup_dirs; do ... rm -rf "$dir"; done
#
# BACKUP_DIR is "$HOME/.ods/backups", and a $HOME with a space is ordinary on
# WSL (/mnt/c/Users/First Last) and macOS. Unquoted word-splitting turned each
# full path into fragments, so:
#
#   * retention never pruned  — every real backup survived past MAX_BACKUPS
#   * basename logged garbage — "My", "home", "with"
#   * the trailing fragment is a RELATIVE path, so `rm -rf` resolved it
#     against the caller's CWD and could destroy an unrelated directory
#
# Usage: bash tests/test-update-backup-prune-spaces.sh
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ODS_UPDATE="$SCRIPT_DIR/ods-update.sh"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

PASSED=0
FAILED=0
pass() { echo -e "${GREEN}✓${NC} $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "${RED}✗${NC} $1"; FAILED=$((FAILED + 1)); }
info() { echo -e "${BLUE}ℹ${NC} $1"; }

[[ -f "$ODS_UPDATE" ]] || { echo "ods-update.sh not found at $ODS_UPDATE"; exit 1; }

for dep in jq curl; do
    if ! command -v "$dep" >/dev/null 2>&1; then
        echo "SKIP: $dep is required by ods-update.sh but is not installed"
        exit 0
    fi
done

TMP="$(mktemp -d "${TMPDIR:-/tmp}/ods-prune-spaces.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

MAX=10
KEEP=12   # pre-existing backups; +1 created by the run => 3 must be pruned

# Spaces in both the home and the install path — the shape that broke.
FAKE_HOME="$TMP/home with space"
INSTALL="$TMP/My ODS/install"
BACKUPS="$FAKE_HOME/.ods/backups"

setup_fixture() {
    rm -rf "$FAKE_HOME" "$INSTALL"
    mkdir -p "$BACKUPS" "$INSTALL"
    : > "$INSTALL/.env"
    echo '{"version":"1.0.0"}' > "$INSTALL/.version"
    cp "$ODS_UPDATE" "$INSTALL/ods-update.sh"
    local i
    for i in $(seq -w 1 "$KEEP"); do
        mkdir -p "$BACKUPS/backup-202401${i}-120000"
    done
}

# ---------------------------------------------------------------------------
info "Retention prunes to MAX_BACKUPS when the path contains spaces"
# ---------------------------------------------------------------------------
setup_fixture
run_exit=0
HOME="$FAKE_HOME" MAX_BACKUPS="$MAX" \
    bash "$INSTALL/ods-update.sh" backup > "$TMP/run.out" 2>&1 || run_exit=$?

if [[ $run_exit -eq 0 ]]; then
    pass "backup command succeeds"
else
    fail "backup command exited $run_exit"
    sed -n '1,20p' "$TMP/run.out"
fi

remaining=$(find "$BACKUPS" -maxdepth 1 -type d -name "backup-*" | wc -l | tr -d ' ')
if [[ "$remaining" -eq "$MAX" ]]; then
    pass "retained exactly MAX_BACKUPS ($MAX) backups"
else
    fail "expected $MAX backups after prune, found $remaining (retention did not run)"
fi

# The three oldest must be gone and the newest kept.
gone=0
for i in 01 02 03; do
    [[ -d "$BACKUPS/backup-202401${i}-120000" ]] || gone=$((gone + 1))
done
if [[ $gone -eq 3 ]]; then
    pass "the three oldest backups were pruned"
else
    fail "expected the 3 oldest pruned, only $gone are gone"
fi

if [[ -d "$BACKUPS/backup-20240112-120000" ]]; then
    pass "the newest pre-existing backup was retained"
else
    fail "prune removed a backup it should have kept"
fi

# ---------------------------------------------------------------------------
info "Prune logs real backup names, not path fragments"
# ---------------------------------------------------------------------------
# Word-splitting produced "Removing old backup: My" / "home" / "with".
if grep -qE "Removing old backup: (My|home|with|space|ODS)$" "$TMP/run.out"; then
    fail "log shows path fragments — the path was word-split"
    grep "Removing old backup" "$TMP/run.out" | head -5
else
    pass "no path fragments in the prune log"
fi

if [[ "$(grep -c "Removing old backup" "$TMP/run.out")" -eq 3 ]]; then
    pass "exactly 3 prune messages (one per removed backup)"
else
    fail "expected 3 prune messages, got $(grep -c 'Removing old backup' "$TMP/run.out")"
fi

# ---------------------------------------------------------------------------
info "Prune never deletes outside BACKUP_DIR"
# ---------------------------------------------------------------------------
# The trailing fragment of a split path is RELATIVE, so `rm -rf` resolved it
# against the caller's CWD. Reproduce that CWD and assert the bystander lives.
setup_fixture
VICTIM="$TMP/cwd"
BYSTANDER="$VICTIM/space/.ods/backups/backup-20240101-120000"
mkdir -p "$BYSTANDER"
echo "do not delete" > "$BYSTANDER/sentinel.txt"

( cd "$VICTIM" && HOME="$FAKE_HOME" MAX_BACKUPS="$MAX" \
    bash "$INSTALL/ods-update.sh" backup > "$TMP/run2.out" 2>&1 )

if [[ -f "$BYSTANDER/sentinel.txt" ]]; then
    pass "a same-named directory under CWD is left untouched"
else
    fail "prune deleted an unrelated directory outside BACKUP_DIR"
fi

# ---------------------------------------------------------------------------
info "Source uses NUL-delimited iteration"
# ---------------------------------------------------------------------------
# Guards the shape directly: a future edit back to `for dir in $backup_dirs`
# would restore the defect even if a fixture happened to pass.
prune_block=$(sed -n '/# Cleanup old backups/,/^}/p' "$ODS_UPDATE")
if grep -q "read -r -d ''" <<<"$prune_block" && grep -q -- "-print0" <<<"$prune_block"; then
    pass "prune reads NUL-delimited paths from find -print0"
else
    fail "prune is not NUL-delimited"
fi

if grep -qE 'for [a-z_]+ in \$backup_dirs' <<<"$prune_block"; then
    fail "prune still iterates unquoted word-split output"
else
    pass "prune does not iterate unquoted word-split output"
fi

echo ""
echo "Passed: $PASSED  Failed: $FAILED"
[[ $FAILED -eq 0 ]]
