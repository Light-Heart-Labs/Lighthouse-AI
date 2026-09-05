#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPDATE_SCRIPT="$ROOT_DIR/ods-update.sh"

fail() { echo "[FAIL] $*"; exit 1; }
pass() { echo "[PASS] $*"; }

command -v jq >/dev/null 2>&1 || fail "jq is required"
command -v git >/dev/null 2>&1 || fail "git is required"
[[ -f "$UPDATE_SCRIPT" ]] || fail "ods-update.sh not found"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

INSTALL_DIR="$TMP_DIR/ods"
BIN_DIR="$TMP_DIR/bin"
mkdir -p "$INSTALL_DIR/data" "$INSTALL_DIR/config/litellm" "$BIN_DIR"

cp "$UPDATE_SCRIPT" "$INSTALL_DIR/ods-update.sh"
chmod +x "$INSTALL_DIR/ods-update.sh"

cat > "$INSTALL_DIR/.env" <<'EOF'
ODS_MODE=local
GPU_BACKEND=cpu
GPU_COUNT=1
TIER=1
DASHBOARD_API_PORT=3002
OLLAMA_PORT=8080
EOF

cat > "$INSTALL_DIR/.version" <<'EOF'
{"version":"test-runtime"}
EOF

cat > "$INSTALL_DIR/docker-compose.base.yml" <<'EOF'
services:
  dashboard-api:
    image: example/dashboard-api:test
  litellm:
    image: example/litellm:test
EOF

cat > "$INSTALL_DIR/docker-compose.cpu.yml" <<'EOF'
services:
  llama-server:
    image: example/llama:test
EOF

printf '%s\n' '-f docker-compose.base.yml -f docker-compose.cpu.yml' > "$INSTALL_DIR/.compose-flags"

DOCKER_LOG="$TMP_DIR/docker-args.log"
DOCKER_TOKEN_LOG="$TMP_DIR/docker-token-args.log"
export DOCKER_LOG
export DOCKER_TOKEN_LOG
cat > "$BIN_DIR/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${DOCKER_LOG:?}"
printf '<%s>\n' "$@" >> "${DOCKER_TOKEN_LOG:?}"

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
        next="${args[$((i + 1))]:-}"
        if [[ "$next" == "--services" ]]; then
            printf '%s\n' dashboard-api litellm
            exit 0
        fi
        if [[ "$next" == "--format" ]]; then
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
if [[ "$*" == *"api.github.com/repos/"*"releases/latest"* ]]; then
    printf '%s\n' '{"tag_name":"v9.9.9"}'
fi
exit 0
SH
chmod +x "$BIN_DIR/curl"

PATH="$BIN_DIR:$PATH" bash "$INSTALL_DIR/ods-update.sh" health > "$TMP_DIR/health.out" 2>&1 \
    || { cat "$TMP_DIR/health.out"; fail "health should pass with saved compose flags"; }

grep -q "Service dashboard-api: running" "$TMP_DIR/health.out" \
    || { cat "$TMP_DIR/health.out"; fail "health did not inspect dashboard-api"; }
grep -q -- "-f docker-compose.base.yml -f docker-compose.cpu.yml ps --services" "$DOCKER_LOG" \
    || { cat "$DOCKER_LOG"; fail "health did not pass saved compose flags to docker compose ps"; }
if grep -q "No services defined in docker-compose" "$TMP_DIR/health.out"; then
    cat "$TMP_DIR/health.out"
    fail "health emitted stale bare-compose warning"
fi
pass "ods-update health uses saved compose flags in runtime installs"

mkdir -p "$INSTALL_DIR/custom stack"
printf 'services: {}\n' > "$INSTALL_DIR/custom stack/compose.yaml"
printf '%s\n' "-f docker-compose.base.yml -f 'custom stack/compose.yaml'" \
    > "$INSTALL_DIR/.compose-flags"
: > "$DOCKER_TOKEN_LOG"
PATH="$BIN_DIR:$PATH" bash "$INSTALL_DIR/ods-update.sh" health > "$TMP_DIR/spaced-health.out" 2>&1 \
    || { cat "$TMP_DIR/spaced-health.out"; fail "health should preserve a quoted compose path containing spaces"; }
grep -qF '<custom stack/compose.yaml>' "$DOCKER_TOKEN_LOG" \
    || { cat "$DOCKER_TOKEN_LOG"; fail "quoted compose path was split into multiple Docker arguments"; }
pass "ods-update health preserves quoted compose paths as single arguments"

PATH="$BIN_DIR:$PATH" bash "$INSTALL_DIR/ods-update.sh" backup runtime-smoke > "$TMP_DIR/backup.out" 2>&1 \
    || { cat "$TMP_DIR/backup.out"; fail "backup should not fail while counting copied files"; }
grep -q "Backup created:" "$TMP_DIR/backup.out" \
    || { cat "$TMP_DIR/backup.out"; fail "backup did not report created snapshot"; }
pass "ods-update backup counts copied files under set -e"

cat > "$INSTALL_DIR/.version" <<'EOF'
{"version":"1.0.0"}
EOF
PATH="$BIN_DIR:$PATH" bash "$INSTALL_DIR/ods-update.sh" check > "$TMP_DIR/check.out" 2>&1 \
    || { cat "$TMP_DIR/check.out"; fail "check should pass with mocked release API"; }
grep -q "ods update" "$TMP_DIR/check.out" \
    || { cat "$TMP_DIR/check.out"; fail "check did not recommend runtime update command"; }
if grep -q "Run 'ods-update.sh update' to update" "$TMP_DIR/check.out"; then
    cat "$TMP_DIR/check.out"
    fail "check still recommends direct source updater for runtime installs"
fi
pass "ods-update check recommends runtime update command"

SOURCE_BIN_DIR="$TMP_DIR/source-bin"
SOURCE_PARENT="$TMP_DIR/source-parent"
SOURCE_INSTALL="$SOURCE_PARENT/ods"
mkdir -p "$SOURCE_BIN_DIR" "$SOURCE_INSTALL"
cp "$UPDATE_SCRIPT" "$SOURCE_INSTALL/ods-update.sh"
chmod +x "$SOURCE_INSTALL/ods-update.sh"
cat > "$SOURCE_BIN_DIR/curl" <<'SH'
#!/usr/bin/env bash
if [[ "$*" == *"api.github.com/repos/"*"releases/latest"* ]]; then
    printf '%s\n' '{"tag_name":"v9.9.9"}'
fi
exit 0
SH
chmod +x "$SOURCE_BIN_DIR/curl"
git -C "$SOURCE_PARENT" init -q
git -C "$SOURCE_PARENT" add ods/ods-update.sh
PATH="$SOURCE_BIN_DIR:$PATH" bash "$SOURCE_INSTALL/ods-update.sh" check > "$TMP_DIR/source-check.out" 2>&1 \
    || { cat "$TMP_DIR/source-check.out"; fail "check should pass in nested source checkout"; }
grep -q "Source checkout detected" "$TMP_DIR/source-check.out" \
    || { cat "$TMP_DIR/source-check.out"; fail "nested source checkout was not recognized"; }
pass "ods-update recognizes nested source checkout layout"

: > "$DOCKER_LOG"
set +e
PATH="$BIN_DIR:$PATH" bash "$INSTALL_DIR/ods-update.sh" update > "$TMP_DIR/update.out" 2>&1
update_exit=$?
set -e

[[ "$update_exit" -ne 0 ]] || fail "update without .git should fail"
grep -q "git-backed ODS source checkout" "$TMP_DIR/update.out" \
    || { cat "$TMP_DIR/update.out"; fail "missing non-git install diagnosis"; }
grep -q "./ods-cli update" "$TMP_DIR/update.out" \
    || { cat "$TMP_DIR/update.out"; fail "missing runtime update guidance"; }
if find "$INSTALL_DIR/data/backups" -mindepth 1 -maxdepth 1 -type d -name 'pre-update-*' 2>/dev/null | grep -q .; then
    find "$INSTALL_DIR/data/backups" -mindepth 1 -maxdepth 1 -type d -name 'pre-update-*'
    fail "non-git update created a rollback snapshot before preflight"
fi
[[ ! -s "$DOCKER_LOG" ]] || { cat "$DOCKER_LOG"; fail "non-git update invoked Docker"; }
pass "ods-update fails cleanly before mutating non-git runtime installs"

#------------------------------------------------------------------------------
# Regression: `ps --services` emits one service name per line and Compose allows
# spaces in a service name. cmd_health used to collect that into a scalar and
# iterate it unquoted, word-splitting "custom worker" into "custom" + "worker".
# Each fragment then matched no container, reported "unknown", and failed the
# health check for a stack that was actually running.
#------------------------------------------------------------------------------
SPACE_BIN_DIR="$TMP_DIR/space-bin"
mkdir -p "$SPACE_BIN_DIR"
SERVICE_QUERY_LOG="$TMP_DIR/service-queries.log"
PS_SERVICES_EXIT="$TMP_DIR/ps-services-exit"
export SERVICE_QUERY_LOG PS_SERVICES_EXIT
printf '0\n' > "$PS_SERVICES_EXIT"
: > "$SERVICE_QUERY_LOG"

cat > "$SPACE_BIN_DIR/docker" <<'SH'
#!/usr/bin/env bash
[[ "${1:-}" == "info" ]] && exit 0
if [[ "${1:-}" == "compose" && "${2:-}" == "version" ]]; then exit 0; fi
[[ "${1:-}" == "compose" ]] && shift

args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
    if [[ "${args[$i]}" == "ps" ]]; then
        next="${args[$((i + 1))]:-}"
        if [[ "$next" == "--services" ]]; then
            # Simulate a failing `ps` when the fixture asks for it.
            if [[ "$(cat "${PS_SERVICES_EXIT:?}")" != "0" ]]; then
                echo "compose: no configuration file provided" >&2
                exit 1
            fi
            printf '%s\n' 'dashboard-api' 'custom worker' 'litellm'
            exit 0
        fi
        if [[ "$next" == "--format" ]]; then
            # docker compose ps --format json <service>
            requested="${args[$((i + 3))]:-}"
            printf '%s\n' "$requested" >> "${SERVICE_QUERY_LOG:?}"
            case "$requested" in
                dashboard-api|"custom worker"|litellm)
                    printf '%s\n' '{"State":"running"}' ;;
                *)
                    printf '%s\n' '[]' ;;
            esac
            exit 0
        fi
    fi
done
exit 0
SH
chmod +x "$SPACE_BIN_DIR/docker"

printf '%s\n' '-f docker-compose.base.yml -f docker-compose.cpu.yml' > "$INSTALL_DIR/.compose-flags"

PATH="$SPACE_BIN_DIR:$BIN_DIR:$PATH" bash "$INSTALL_DIR/ods-update.sh" health \
    > "$TMP_DIR/spaced-service.out" 2>&1 \
    || { cat "$TMP_DIR/spaced-service.out"; fail "health should pass when a service name contains a space"; }

grep -qF "Service custom worker: running" "$TMP_DIR/spaced-service.out" \
    || { cat "$TMP_DIR/spaced-service.out"; fail "spaced service name was not reported as a single running service"; }
if grep -Eq "Service (custom|worker): " "$TMP_DIR/spaced-service.out"; then
    cat "$TMP_DIR/spaced-service.out"
    fail "spaced service name was word-split into separate services"
fi
grep -qF "All health checks passed" "$TMP_DIR/spaced-service.out" \
    || { cat "$TMP_DIR/spaced-service.out"; fail "a healthy stack was flagged unhealthy by the spaced service name"; }
grep -qxF "custom worker" "$SERVICE_QUERY_LOG" \
    || { cat "$SERVICE_QUERY_LOG"; fail "per-service ps was not queried with the whole service name"; }
if grep -qxE "custom|worker" "$SERVICE_QUERY_LOG"; then
    cat "$SERVICE_QUERY_LOG"
    fail "per-service ps was queried with a word-split fragment"
fi
pass "ods-update health treats a spaced service name as one service"

# A failing `ps --services` must warn and return 1, never fall through and
# iterate a single empty service name.
printf '1\n' > "$PS_SERVICES_EXIT"
: > "$SERVICE_QUERY_LOG"
set +e
PATH="$SPACE_BIN_DIR:$BIN_DIR:$PATH" bash "$INSTALL_DIR/ods-update.sh" health \
    > "$TMP_DIR/no-services.out" 2>&1
no_services_exit=$?
set -e

[[ "$no_services_exit" -ne 0 ]] \
    || { cat "$TMP_DIR/no-services.out"; fail "health should fail when the service list cannot be resolved"; }
grep -q "No services found for resolved compose stack" "$TMP_DIR/no-services.out" \
    || { cat "$TMP_DIR/no-services.out"; fail "health did not warn about the unresolvable service list"; }
if grep -q "Service : " "$TMP_DIR/no-services.out"; then
    cat "$TMP_DIR/no-services.out"
    fail "health iterated an empty service name after a failed ps"
fi
[[ ! -s "$SERVICE_QUERY_LOG" ]] \
    || { cat "$SERVICE_QUERY_LOG"; fail "health queried a service after ps --services failed"; }
pass "ods-update health fails cleanly when the service list cannot be resolved"
