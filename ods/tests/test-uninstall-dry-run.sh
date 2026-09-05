#!/usr/bin/env bash
# Public dry-run contract: enumerate uninstall scope without mutating the host.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

INSTALL_DIR="$TMP_DIR/ODS install"
TEST_HOME="$TMP_DIR/home"
STUB_BIN="$TMP_DIR/bin"
DOCKER_LOG="$TMP_DIR/docker.log"
mkdir -p "$INSTALL_DIR/lib" "$INSTALL_DIR/data/models" "$TEST_HOME/.ods" "$STUB_BIN"
cp "$ROOT_DIR/ods-uninstall.sh" "$INSTALL_DIR/ods-uninstall.sh"
touch "$INSTALL_DIR/ods-cli" "$INSTALL_DIR/data/models/model.gguf"
printf '%s\n' '-f docker-compose.base.yml' > "$INSTALL_DIR/.compose-flags"
printf '%s\n' 'GPU_BACKEND=nvidia' > "$INSTALL_DIR/.env"

cat > "$INSTALL_DIR/lib/safe-env.sh" <<'STUB'
load_env_file() { return 0; }
STUB

cat > "$STUB_BIN/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
case "$*" in
    'ps -a --format {{.Names}}') printf '%s\n' ods-dashboard unrelated ods-llama-server ;;
    'volume ls --format {{.Name}}') printf '%s\n' ods_data unrelated ods-models ;;
esac
STUB
chmod +x "$STUB_BIN/docker"

run_plan() {
    HOME="$TEST_HOME" PATH="$STUB_BIN:$PATH" DOCKER_LOG="$DOCKER_LOG" \
        bash "$INSTALL_DIR/ods-uninstall.sh" "$@"
}

default_json=$(run_plan --dry-run --json)
jq -e --arg install_dir "$INSTALL_DIR" '
    .schema_version == "ods.uninstall-plan.v1" and
    .dry_run == true and
    .mutates == false and
    .install_dir == $install_dir and
    .options == {keep_data: false, keep_models: false} and
    .compose.flags == "-f docker-compose.base.yml" and
    .compose.containers == ["ods-dashboard", "ods-llama-server"] and
    .compose.volumes == ["ods_data", "ods-models"] and
    .compose.remove_volumes == true and
    .filesystem.install_action == "remove" and
    .filesystem.backup_dir.action == "remove"
' <<< "$default_json" >/dev/null || {
    printf 'FAIL: default uninstall plan contract changed\n' >&2
    exit 1
}
printf 'PASS: default uninstall plan exposes destructive scope\n'

preserve_json=$(run_plan --keep-data --keep-models --dry-run --json)
jq -e --arg data_path "$INSTALL_DIR/data" --arg model_path "$TEST_HOME/.ods-models-backup" '
    .options == {keep_data: true, keep_models: true} and
    .compose.volumes == [] and
    .compose.remove_volumes == false and
    .filesystem.install_action == "preserve-data" and
    .filesystem.preserved_data_path == $data_path and
    .filesystem.models == {action: "preserve-separately", backup_path: $model_path}
' <<< "$preserve_json" >/dev/null || {
    printf 'FAIL: preservation options were not reflected in uninstall plan\n' >&2
    exit 1
}
printf 'PASS: preservation options change the plan without changing host state\n'

data_only_json=$(run_plan --keep-data --dry-run --json)
jq -e '
    .filesystem.models == {action: "preserve-with-data", backup_path: null}
' <<< "$data_only_json" >/dev/null || {
    printf 'FAIL: data preservation did not account for the model directory\n' >&2
    exit 1
}
printf 'PASS: keep-data reports models preserved in place\n'

[[ -f "$INSTALL_DIR/data/models/model.gguf" ]] \
    || { printf 'FAIL: dry run removed model data\n' >&2; exit 1; }
[[ -d "$TEST_HOME/.ods" ]] \
    || { printf 'FAIL: dry run removed backup data\n' >&2; exit 1; }
if grep -Eq 'compose .*down|volume rm|rm -f' "$DOCKER_LOG"; then
    printf 'FAIL: dry run invoked a destructive Docker command\n' >&2
    exit 1
fi
printf 'PASS: dry run performs discovery only\n'

human_out=$(run_plan --dry-run)
grep -qF 'No changes made.' <<< "$human_out" \
    || { printf 'FAIL: human dry run omitted the no-mutation receipt\n' >&2; exit 1; }
printf 'PASS: human dry run reports that no changes were made\n'
