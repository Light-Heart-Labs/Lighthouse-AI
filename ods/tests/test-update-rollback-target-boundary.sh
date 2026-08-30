#!/usr/bin/env bash
# Regression coverage for explicit ods-update rollback targets.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURE="$(mktemp -d "${TMPDIR:-/tmp}/ods-update-rollback-id.XXXXXX")"
trap 'rm -rf "$FIXTURE"' EXIT

INSTALL_DIR="$FIXTURE/install"
HOME_DIR="$FIXTURE/home"
BIN_DIR="$FIXTURE/bin"
DOCKER_LOG="$FIXTURE/docker.log"
mkdir -p "$INSTALL_DIR/data/backups" "$HOME_DIR/.ods/backups" "$BIN_DIR"
cp "$ROOT_DIR/ods-update.sh" "$INSTALL_DIR/ods-update.sh"

pass_count=0

pass() {
    echo "PASS: $1"
    pass_count=$((pass_count + 1))
}

fail() {
    echo "FAIL: $1" >&2
    exit 1
}

cat > "$BIN_DIR/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${DOCKER_LOG:?}"

if [[ "${1:-}" == "info" ]]; then
    exit 0
fi
if [[ "${1:-}" == "compose" && "${2:-}" == "version" ]]; then
    exit 0
fi
if [[ "${1:-}" == "compose" ]]; then
    shift
fi

args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
    if [[ "${args[$i]}" == "ps" ]]; then
        if [[ "${args[$((i + 1))]:-}" == "--services" ]]; then
            printf '%s\n' dashboard-api
            exit 0
        fi
        if [[ "${args[$((i + 1))]:-}" == "--format" ]]; then
            printf '%s\n' '{"State":"running"}'
            exit 0
        fi
    fi
done

exit 0
SH
chmod +x "$BIN_DIR/docker"

cat > "$BIN_DIR/curl" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$BIN_DIR/curl"

cat > "$INSTALL_DIR/docker-compose.base.yml" <<'YAML'
services:
  dashboard-api:
    image: example/dashboard:test
YAML
cat > "$INSTALL_DIR/docker-compose.nvidia.yml" <<'YAML'
services:
  llama-server:
    image: example/llama:nvidia
YAML
cat > "$INSTALL_DIR/docker-compose.cpu.yml" <<'YAML'
services:
  llama-server:
    image: example/llama:cpu
YAML

write_live_env() {
    cat > "$INSTALL_DIR/.env" <<'EOF'
MARKER=live
ODS_MODE=local
GPU_BACKEND=nvidia
GPU_COUNT=1
TIER=1
EOF
}

write_legacy_backup() {
    local directory="$1"
    local marker="$2"
    mkdir -p "$directory"
    cat > "$directory/.env" <<EOF
MARKER=$marker
ODS_MODE=local
GPU_BACKEND=cpu
GPU_COUNT=1
TIER=1
EOF
}

run_rollback() {
    local output_file="$1"
    local target="$2"

    set +e
    HOME="$HOME_DIR" PATH="$BIN_DIR:$PATH" DOCKER_LOG="$DOCKER_LOG" \
        HEALTH_TIMEOUT=2 bash "$INSTALL_DIR/ods-update.sh" rollback "$target" \
        >"$output_file" 2>&1
    local status=$?
    set -e
    return "$status"
}

assert_rejected() {
    local description="$1"
    local target="$2"
    local output_file="$FIXTURE/output.log"

    write_live_env
    : > "$DOCKER_LOG"
    if run_rollback "$output_file" "$target"; then
        fail "$description was accepted"
    fi
    grep -qF "Invalid rollback target" "$output_file" \
        || fail "$description did not explain the target constraint"
    grep -qF "MARKER=live" "$INSTALL_DIR/.env" \
        || fail "$description replaced live configuration"
    [[ ! -s "$DOCKER_LOG" ]] \
        || fail "$description touched Docker before validation"
    pass "$description is rejected before state mutation"
}

# ROLLBACK_DIR is install/data/backups. This sibling was previously selected
# through data/backups/../external and restored as a legacy backup.
write_legacy_backup "$INSTALL_DIR/data/external" external
assert_rejected "parent-directory traversal" ../external

assert_rejected "dot target" .
assert_rejected "backslash-separated target" 'group\backup'
assert_rejected "control-character target" $'bad\ntarget'

# Named general backups can contain spaces, so valid single segments must stay
# compatible. Passing "team demo" selects backup-team demo below BACKUP_DIR.
write_legacy_backup "$HOME_DIR/.ods/backups/backup-team demo" restored
write_live_env
: > "$DOCKER_LOG"
if ! run_rollback "$FIXTURE/valid.log" "team demo"; then
    cat "$FIXTURE/valid.log" >&2
    fail "valid named backup target was rejected"
fi
grep -qF "MARKER=restored" "$INSTALL_DIR/.env" \
    || fail "valid named backup did not restore configuration"
[[ -s "$DOCKER_LOG" ]] || fail "valid rollback did not reach Docker lifecycle"
pass "valid named backup target completes rollback"

echo "Result: $pass_count passed"
