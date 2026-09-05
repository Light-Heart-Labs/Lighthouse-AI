#!/usr/bin/env bash
# Regression coverage for #2624: `ods status` must not report an internal-only
# service (published via compose `expose:`, with no host `ports:` mapping) as
# "not responding" when its container's own Docker healthcheck is healthy.
#
# model-router is the canonical case — it listens on 9099 inside the Docker
# network but is never bound to 127.0.0.1 on the host, so the loopback HTTP
# probe in cmd_status()/cmd_status_json() always fails. The fix falls back to
# the container's Docker healthcheck (`docker inspect .State.Health.Status`).
#
# Run: bash tests/test-status-internal-only-health.sh

set -euo pipefail

# ods-cli requires Bash 4+; macOS ships Bash 3.2. Re-exec under a modern bash
# when available, otherwise skip (mirrors test-ods-cli-pipefail-tolerance.sh).
if [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
    for _modern_bash in /opt/homebrew/bin/bash /usr/local/bin/bash; do
        if [ -x "$_modern_bash" ] && [ "$("$_modern_bash" -c 'echo "${BASH_VERSINFO[0]}"')" -ge 4 ]; then
            exec "$_modern_bash" "$0" "$@"
        fi
    done
    echo "[SKIP] ods-cli requires Bash 4+; this host only has Bash ${BASH_VERSION} (brew install bash)"
    echo "Result: 0 passed, 0 failed, 1 skipped"
    exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ODS_CLI="$ROOT_DIR/ods-cli"

# Registry parsing needs python3 + PyYAML; without it sr_load can't populate the
# service map and this test can't exercise the probe path. Skip cleanly.
if ! python3 -c "import yaml" >/dev/null 2>&1; then
    echo "[SKIP] python3 + PyYAML required to load the service registry"
    echo "Result: 0 passed, 0 failed, 1 skipped"
    exit 0
fi

TMP_DIR="$(mktemp -d)"
INSTALL_DIR="$TMP_DIR/install"
BIN_DIR="$TMP_DIR/bin"
trap 'rm -rf "$TMP_DIR"' EXIT

PASS=0
FAIL=0
pass() { echo "[PASS] $1"; PASS=$((PASS + 1)); }
fail() { echo "[FAIL] $1"; [[ -n "${2:-}" ]] && echo "       $2"; FAIL=$((FAIL + 1)); }

# ── Fixture install root ──────────────────────────────────────────────────
# check_install needs docker-compose.base.yml; get_compose_flags short-circuits
# on a valid .compose-flags cache, so no docker is invoked to resolve the stack.
mkdir -p "$INSTALL_DIR"
cp "$ROOT_DIR/docker-compose.base.yml" "$INSTALL_DIR/docker-compose.base.yml"
printf '%s' "-f docker-compose.base.yml" > "$INSTALL_DIR/.compose-flags"
: > "$INSTALL_DIR/.env"

# ── Stubs ─────────────────────────────────────────────────────────────────
# curl: nothing is reachable on the host loopback (models the expose-only port).
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/curl" <<'SH'
#!/usr/bin/env bash
echo "curl: (7) Failed to connect to 127.0.0.1" >&2
exit 7
SH

# docker: `compose ps` lists only the top table; the {{.Name}} form returns
# nothing so non-core services are skipped. `inspect` reports the model-router
# container's health from MR_HEALTH; every other container reports "none" so the
# fallback only ever upgrades model-router.
cat > "$BIN_DIR/docker" <<'SH'
#!/usr/bin/env bash
args="$*"
if [[ "$1" == "compose" ]]; then
    if [[ "$args" == *" ps "* || "$args" == *" ps" ]]; then
        if [[ "$args" == *table* ]]; then
            printf '%s\n' "NAME              STATUS               PORTS"
            printf '%s\n' "ods-model-router  Up 1 hour (healthy)  9099/tcp"
        fi
        # {{.Name}} / {{.Service}} forms: print nothing → non-core skipped.
        exit 0
    fi
    exit 0
fi
if [[ "$1" == "inspect" ]]; then
    container="${!#}"   # last positional arg is the container name
    if [[ "$container" == "ods-model-router" ]]; then
        echo "${MR_HEALTH:-none}"
    else
        echo "none"
    fi
    exit 0
fi
exit 0
SH
chmod +x "$BIN_DIR/curl" "$BIN_DIR/docker"
export PATH="$BIN_DIR:$PATH"

run_status() {
    # Inherits MR_HEALTH from the environment; the stub docker reads it.
    ODS_HOME="$INSTALL_DIR" NO_COLOR=1 "$BASH" "$ODS_CLI" "$@" 2>&1
}

mr_line() { grep -i "ODS Model Router" <<<"$1" || true; }

# ── 1. Healthy container → status reports healthy despite failed HTTP probe ──
export MR_HEALTH="healthy"
OUT="$(run_status status)"
LINE="$(mr_line "$OUT")"
if [[ "$LINE" == *"healthy"* && "$LINE" != *"not responding"* ]]; then
    pass "healthy internal-only service reported healthy in 'ods status'"
else
    fail "healthy internal-only service not reported healthy" "got: [$LINE]"
fi

JSON_OUT="$(run_status status --json)"
MR_STATUS="$(jq -r '.services[] | select(.id=="model-router") | .status' <<<"$JSON_OUT" 2>/dev/null || true)"
if [[ "$MR_STATUS" == "healthy" ]]; then
    pass "healthy internal-only service reported healthy in 'ods status --json'"
else
    fail "status --json did not report model-router healthy" "got: [$MR_STATUS]"
fi

# ── 2. Negative control: unhealthy container must still surface as down ──────
export MR_HEALTH="unhealthy"
OUT="$(run_status status)"
LINE="$(mr_line "$OUT")"
if [[ "$LINE" == *"not responding"* ]]; then
    pass "unhealthy internal-only service still reported not responding"
else
    fail "fallback masked a genuinely unhealthy service" "got: [$LINE]"
fi

JSON_OUT="$(run_status status --json)"
MR_STATUS="$(jq -r '.services[] | select(.id=="model-router") | .status' <<<"$JSON_OUT" 2>/dev/null || true)"
if [[ "$MR_STATUS" == "unhealthy" ]]; then
    pass "status --json still reports unhealthy for a down container"
else
    fail "status --json masked a down container" "got: [$MR_STATUS]"
fi

echo ""
echo "Passed: $PASS  Failed: $FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
echo "[PASS] internal-only service health fallback (#2624)"
