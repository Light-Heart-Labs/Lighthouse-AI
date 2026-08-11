#!/bin/bash
# A backup archive is untrusted input. Its member *names* can be perfectly
# ordinary while a member is a symlink whose target names any path on the
# host — `[[ -f ]]`, `[[ -d ]]` and `cp`'s source operand all follow it.
#
# These tests pin that a symlinked restore source is refused, and that an
# ordinary backup containing a nested symlink still restores.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ODS_RESTORE="$SCRIPT_DIR/../ods-restore.sh"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

pass() { echo -e "${GREEN}✓${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; exit 1; }
info() { echo -e "${BLUE}ℹ${NC} $1"; }

[[ -x "$ODS_RESTORE" ]] || fail "ods-restore.sh not found or not executable"
command -v python3 >/dev/null 2>&1 || fail "python3 is required to build the fixtures"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

BID="20260101-000000"

# Build a fake ODS root. ods-restore.sh sources lib/rsync.sh relative to
# ODS_DIR before anything else runs.
new_ods_root() {
    local root="$1"
    mkdir -p "$root/data" "$root/.backups" "$root/lib"
    cp "$SCRIPT_DIR/../lib/rsync.sh" "$root/lib/"
    printf 'compose\n' > "$root/docker-compose.yml"
}

# Write a backup archive whose single interesting member is a symlink.
write_symlink_archive() {
    local archive="$1" member="$2" target="$3"
    python3 - "$archive" "$member" "$target" <<'PY'
import io
import sys
import tarfile

archive, member, target = sys.argv[1:]
with tarfile.open(archive, "w:gz") as tf:
    root = tarfile.TarInfo("20260101-000000")
    root.type = tarfile.DIRTYPE
    # TarInfo defaults to 0o644. On a directory that leaves no traversal bit,
    # so a non-root extractor cannot read manifest.json inside it and the
    # restore fails during validation instead of at the symlink guard this
    # test exists to exercise. Root ignores the bit, so the difference only
    # shows up off a root shell.
    root.mode = 0o755
    tf.addfile(root)
    manifest = (b'{"manifest_version":"1.0","backup_date":"2026-01-01T00:00:00Z",'
                b'"backup_id":"20260101-000000","backup_type":"config",'
                b'"ods_version":"test"}\n')
    info = tarfile.TarInfo("20260101-000000/manifest.json")
    info.mode = 0o644
    info.size = len(manifest)
    tf.addfile(info, io.BytesIO(manifest))
    link = tarfile.TarInfo(f"20260101-000000/{member}")
    link.type = tarfile.SYMTYPE
    link.mode = 0o777
    link.linkname = target
    tf.addfile(link)
PY
}

run_restore() {
    local root="$1"
    set +e
    ODS_DIR="$root" bash "$ODS_RESTORE" --config-only --skip-verify -f "$BID" \
        > "$TMP/restore.out" 2>&1
    local rc=$?
    set -e
    echo "$rc"
}

# --- a symlinked config/ directory must not be followed --------------------

info "Symlinked config/ entry is refused"
ODS_A="$TMP/a"
new_ods_root "$ODS_A"
mkdir -p "$TMP/outside-a/config"
printf 'outside-canary\n' > "$TMP/outside-a/config/secret.txt"
write_symlink_archive "$ODS_A/.backups/$BID.tar.gz" "config" "$TMP/outside-a/config"

rc="$(run_restore "$ODS_A")"
[[ "$rc" -ne 0 ]] || fail "Expected a nonzero exit for a symlinked config/ entry, got $rc"
[[ ! -e "$ODS_A/config/secret.txt" ]] \
    || fail "Outside file was copied into the ODS tree"
grep -q "is a symlink to" "$TMP/restore.out" \
    || fail "Expected the error to name the symlink; got: $(cat "$TMP/restore.out")"
pass "Symlinked config/ is refused and nothing outside the backup is copied"

# --- a symlinked .env must not be followed either --------------------------

info "Symlinked .env entry is refused"
ODS_B="$TMP/b"
new_ods_root "$ODS_B"
printf 'SECRET-OUTSIDE-CONTENT\n' > "$TMP/host-secret"
write_symlink_archive "$ODS_B/.backups/$BID.tar.gz" ".env" "$TMP/host-secret"

rc="$(run_restore "$ODS_B")"
[[ "$rc" -ne 0 ]] || fail "Expected a nonzero exit for a symlinked .env entry, got $rc"
if [[ -f "$ODS_B/.env" ]] && grep -q "SECRET-OUTSIDE-CONTENT" "$ODS_B/.env"; then
    fail "Contents of a host file outside the backup were written into .env"
fi
pass "Symlinked .env is refused and no host file contents are pulled in"

# --- an ordinary backup with a nested symlink still restores ---------------
# `cp -r` recreates nested symlinks as links rather than following them, so
# rejecting the source operand must not reject a legitimate tree that merely
# contains one. Guards against over-blocking.

info "Ordinary backup containing a nested symlink still restores"
ODS_C="$TMP/c"
new_ods_root "$ODS_C"
STAGE="$TMP/stage/$BID"
mkdir -p "$STAGE/config"
cat > "$STAGE/manifest.json" <<'JSON'
{
  "manifest_version": "1.0",
  "backup_date": "2026-01-01T00:00:00Z",
  "backup_id": "20260101-000000",
  "backup_type": "config",
  "ods_version": "test"
}
JSON
printf 'real-config\n' > "$STAGE/config/settings.json"
ln -s "settings.json" "$STAGE/config/alias.json"
tar czf "$ODS_C/.backups/$BID.tar.gz" -C "$TMP/stage" "$BID"

rc="$(run_restore "$ODS_C")"
[[ "$rc" -eq 0 ]] || fail "Ordinary backup should restore, got rc=$rc: $(cat "$TMP/restore.out")"
[[ -f "$ODS_C/config/settings.json" ]] || fail "Expected config/settings.json to be restored"
[[ -L "$ODS_C/config/alias.json" ]] \
    || fail "Nested symlink should be restored as a symlink, not dereferenced"
pass "Legitimate backup with a nested symlink restores unchanged"
