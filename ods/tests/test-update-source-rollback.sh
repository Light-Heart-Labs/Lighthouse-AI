#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPDATE_SCRIPT="${ROOT_DIR}/ods-update.sh"

fail() { echo "[FAIL] $*"; exit 1; }
pass() { echo "[PASS] $*"; }

command -v git >/dev/null 2>&1 || fail "git is required"
command -v jq >/dev/null 2>&1 || fail "jq is required"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

REMOTE_DIR="${TMP_DIR}/remote.git"
AUTHOR_DIR="${TMP_DIR}/author"
CHECKOUT_DIR="${TMP_DIR}/checkout"
BIN_DIR="${TMP_DIR}/bin"
mkdir -p "$AUTHOR_DIR/ods/migrations" "$BIN_DIR"

git init -q --bare "$REMOTE_DIR"
git -C "$AUTHOR_DIR" init -q
git -C "$AUTHOR_DIR" config user.name "ODS update test"
git -C "$AUTHOR_DIR" config user.email "ods-update-test@example.invalid"

cp "$UPDATE_SCRIPT" "$AUTHOR_DIR/ods/ods-update.sh"
chmod +x "$AUTHOR_DIR/ods/ods-update.sh"
printf '%s\n' 'release=stable' > "$AUTHOR_DIR/ods/release.txt"
cat > "$AUTHOR_DIR/ods/.env" <<'EOF'
ODS_MODE=local
GPU_BACKEND=cpu
EOF
cat > "$AUTHOR_DIR/ods/.version" <<'EOF'
{"version":"1.0.0"}
EOF
cat > "$AUTHOR_DIR/ods/docker-compose.base.yml" <<'EOF'
services:
  dashboard-api:
    image: example/dashboard-api:test
EOF

git -C "$AUTHOR_DIR" add ods
git -C "$AUTHOR_DIR" commit -qm "initial working release"
git -C "$AUTHOR_DIR" branch -M main
git -C "$AUTHOR_DIR" remote add origin "$REMOTE_DIR"
git -C "$AUTHOR_DIR" push -q -u origin main
git -C "$REMOTE_DIR" symbolic-ref HEAD refs/heads/main

git clone -q "$REMOTE_DIR" "$CHECKOUT_DIR"
baseline_revision="$(git -C "$CHECKOUT_DIR" rev-parse HEAD)"

printf '%s\n' 'release=broken' > "$AUTHOR_DIR/ods/release.txt"
cat > "$AUTHOR_DIR/ods/migrations/migrate-v9.9.9.sh" <<'EOF'
#!/usr/bin/env bash
exit 42
EOF
chmod +x "$AUTHOR_DIR/ods/migrations/migrate-v9.9.9.sh"
git -C "$AUTHOR_DIR" add ods/release.txt ods/migrations/migrate-v9.9.9.sh
git -C "$AUTHOR_DIR" update-index --chmod=+x ods/migrations/migrate-v9.9.9.sh
git -C "$AUTHOR_DIR" commit -qm "publish broken release"
git -C "$AUTHOR_DIR" push -q

cat > "$BIN_DIR/docker" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$BIN_DIR/docker"

set +e
PATH="$BIN_DIR:$PATH" bash "$CHECKOUT_DIR/ods/ods-update.sh" update \
    > "$TMP_DIR/update.log" 2>&1
update_exit=$?
set -e

[[ "$update_exit" -ne 0 ]] || fail "a failing migration must fail the update"
[[ "$(git -C "$CHECKOUT_DIR" rev-parse HEAD)" == "$baseline_revision" ]] \
    || fail "rollback left the checkout on the broken release"
grep -qx 'release=stable' "$CHECKOUT_DIR/ods/release.txt" \
    || fail "rollback did not restore tracked production files"
[[ ! -e "$CHECKOUT_DIR/ods/migrations/migrate-v9.9.9.sh" ]] \
    || fail "rollback left a tracked file introduced by the broken release"
grep -q "Source restored to ${baseline_revision}" "$TMP_DIR/update.log" \
    || { cat "$TMP_DIR/update.log"; fail "rollback did not report the restored revision"; }
pass "failed source update restores the exact pre-pull revision"

printf '%s\n' 'local operator edit' >> "$CHECKOUT_DIR/ods/release.txt"
snapshot_count_before="$(find "$CHECKOUT_DIR/ods/data/backups" -mindepth 1 -maxdepth 1 \
    -type d -name 'pre-update-*' 2>/dev/null | wc -l | tr -d ' ')"

set +e
PATH="$BIN_DIR:$PATH" bash "$CHECKOUT_DIR/ods/ods-update.sh" update \
    > "$TMP_DIR/dirty.log" 2>&1
dirty_exit=$?
set -e

[[ "$dirty_exit" -ne 0 ]] || fail "update must reject tracked operator changes"
grep -q "requires a clean tracked working tree" "$TMP_DIR/dirty.log" \
    || { cat "$TMP_DIR/dirty.log"; fail "dirty checkout diagnosis is missing"; }
snapshot_count_after="$(find "$CHECKOUT_DIR/ods/data/backups" -mindepth 1 -maxdepth 1 \
    -type d -name 'pre-update-*' 2>/dev/null | wc -l | tr -d ' ')"
[[ "$snapshot_count_after" == "$snapshot_count_before" ]] \
    || fail "dirty checkout created a rollback snapshot before preflight"
[[ "$(git -C "$CHECKOUT_DIR" rev-parse HEAD)" == "$baseline_revision" ]] \
    || fail "dirty checkout advanced the source revision"
pass "source update refuses tracked changes before any mutation"

git -C "$CHECKOUT_DIR" restore ods/release.txt

lock_dir="$CHECKOUT_DIR/ods/data/.update.lock"
mkdir -p "$lock_dir"
jq -n --argjson pid "$$" '{pid:$pid}' > "$lock_dir/owner.json"
set +e
PATH="$BIN_DIR:$PATH" bash "$CHECKOUT_DIR/ods/ods-update.sh" update \
    > "$TMP_DIR/concurrent.log" 2>&1
concurrent_exit=$?
set -e
[[ "$concurrent_exit" -ne 0 ]] || fail "concurrent update was not rejected"
grep -q "Another ODS update is already running" "$TMP_DIR/concurrent.log" \
    || { cat "$TMP_DIR/concurrent.log"; fail "concurrent update diagnosis is missing"; }
rm -f "$lock_dir/owner.json"
rmdir "$lock_dir"
pass "update lock rejects a concurrent public command"

# Publish a release that kills the parent updater from inside a migration. This
# leaves both the pulled source and the on-disk transaction journal behind,
# matching an uncatchable process death rather than a normal command failure.
cat > "$AUTHOR_DIR/ods/migrations/migrate-v9.9.9.sh" <<'EOF'
#!/usr/bin/env bash
kill -KILL "$PPID"
EOF
chmod +x "$AUTHOR_DIR/ods/migrations/migrate-v9.9.9.sh"
printf '%s\n' 'release=crash' > "$AUTHOR_DIR/ods/release.txt"
git -C "$AUTHOR_DIR" add ods/release.txt ods/migrations/migrate-v9.9.9.sh
git -C "$AUTHOR_DIR" commit -qm "publish updater-crashing release"
git -C "$AUTHOR_DIR" push -q

# Snapshot IDs have second precision. Keep this transaction independent from
# the earlier rollback point without changing the production timestamp API.
sleep 1
set +e
PATH="$BIN_DIR:$PATH" bash "$CHECKOUT_DIR/ods/ods-update.sh" update \
    > "$TMP_DIR/crash.log" 2>&1
crash_exit=$?
set -e

[[ "$crash_exit" -ne 0 ]] || fail "the crash fixture unexpectedly completed"
[[ "$(git -C "$CHECKOUT_DIR" rev-parse HEAD)" != "$baseline_revision" ]] \
    || fail "the crash fixture did not leave pulled source behind"
journal="$CHECKOUT_DIR/ods/data/update-transaction.json"
[[ "$(jq -r '.state' "$journal")" == "source_updated" ]] \
    || { cat "$journal"; fail "crash journal did not retain the last durable phase"; }

printf '%s\n' 'operator edit after crash' >> "$CHECKOUT_DIR/ods/release.txt"
set +e
PATH="$BIN_DIR:$PATH" bash "$CHECKOUT_DIR/ods/ods-update.sh" update \
    > "$TMP_DIR/recovery-guard.log" 2>&1
guard_exit=$?
set -e
[[ "$guard_exit" -ne 0 ]] || fail "recovery overwrote post-crash operator changes"
grep -q 'operator edit after crash' "$CHECKOUT_DIR/ods/release.txt" \
    || fail "recovery guard did not preserve the operator edit"
[[ "$(jq -r '.state' "$journal")" == "recovery_required" ]] \
    || { cat "$journal"; fail "guarded recovery did not publish an actionable state"; }
grep -q "Reclaimed stale update lock" "$TMP_DIR/recovery-guard.log" \
    || { cat "$TMP_DIR/recovery-guard.log"; fail "recovery did not reclaim the killed updater lock"; }
grep -q "automatic reset refused" "$journal" \
    || { cat "$journal"; fail "recovery receipt omitted the reset refusal"; }
git -C "$CHECKOUT_DIR" restore ods/release.txt
pass "recovery refuses to overwrite post-crash tracked changes"

set +e
PATH="$BIN_DIR:$PATH" bash "$CHECKOUT_DIR/ods/ods-update.sh" update \
    > "$TMP_DIR/recover.log" 2>&1
recover_exit=$?
set -e

[[ "$recover_exit" -ne 0 ]] \
    || fail "recovery must stop before retrying the failed release"
[[ "$(git -C "$CHECKOUT_DIR" rev-parse HEAD)" == "$baseline_revision" ]] \
    || fail "interrupted update recovery left the pulled revision active"
grep -qx 'release=stable' "$CHECKOUT_DIR/ods/release.txt" \
    || fail "interrupted update recovery did not restore production files"
[[ "$(jq -r '.state' "$journal")" == "recovered" ]] \
    || { cat "$journal"; fail "recovery did not publish a terminal receipt"; }
grep -q "Interrupted update recovered" "$TMP_DIR/recover.log" \
    || { cat "$TMP_DIR/recover.log"; fail "recovery outcome was not reported"; }
PATH="$BIN_DIR:$PATH" bash "$CHECKOUT_DIR/ods/ods-update.sh" status \
    > "$TMP_DIR/status.log" 2>&1
grep -q "Update transaction: recovered" "$TMP_DIR/status.log" \
    || { cat "$TMP_DIR/status.log"; fail "public status omitted the recovery receipt"; }
pass "process-death journal restores source and runtime before a retry"

echo "All source update rollback tests passed."
