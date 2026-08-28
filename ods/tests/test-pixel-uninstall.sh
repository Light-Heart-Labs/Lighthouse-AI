#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib/pixel-uninstall.sh
source "$ROOT_DIR/lib/pixel-uninstall.sh"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '[PASS] %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '[FAIL] %s\n' "$1" >&2; }
log_info() { :; }
log_ok() { :; }
log_error() { :; }

TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT
MOCK_BIN="$TEST_ROOT/bin"
SYSTEMD_DIR="$TEST_ROOT/systemd"
ETC_DIR="$TEST_ROOT/etc"
LIBEXEC_DIR="$TEST_ROOT/libexec"
HOME_DIR="$TEST_ROOT/home"
INSTALL_DIR="$TEST_ROOT/install"
SYSTEMCTL_LOG="$TEST_ROOT/systemctl.log"
mkdir -p "$MOCK_BIN" "$SYSTEMD_DIR" "$ETC_DIR" "$LIBEXEC_DIR" "$HOME_DIR"

cat >"$MOCK_BIN/sudo" <<'SH'
#!/usr/bin/env bash
exec "$@"
SH
cat >"$MOCK_BIN/systemctl" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$SYSTEMCTL_LOG"
if [[ "${SYSTEMCTL_FAIL_DISABLE:-false}" == "true" && "${1:-}" == "disable" ]]; then
    exit 1
fi
case " $* " in
    *" is-active --quiet "*) exit 1 ;;
esac
exit 0
SH
chmod +x "$MOCK_BIN/sudo" "$MOCK_BIN/systemctl"
export PATH="$MOCK_BIN:$PATH" SYSTEMCTL_LOG
export ODS_PIXEL_UNINSTALL_SYSTEMD_DIR="$SYSTEMD_DIR"
export ODS_PIXEL_UNINSTALL_ETC_DIR="$ETC_DIR"
export ODS_PIXEL_UNINSTALL_LIBEXEC_DIR="$LIBEXEC_DIR"
ODS_PIXEL_UNINSTALL_ROOT_UID="$(id -u)"
export ODS_PIXEL_UNINSTALL_ROOT_UID

if python3 - "$ROOT_DIR/ods-uninstall.sh" <<'PY'
import pathlib
import sys

text = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
hook = 'ods_pixel_uninstall_managed "$INSTALL_DIR" "$HOME"'
assert '. "$SCRIPT_DIR/lib/pixel-uninstall.sh"' in text
assert hook in text
assert text.index(hook) < text.index("# 1. Stop and remove Docker containers")
PY
then
    pass "ODS uninstaller invokes managed Pixel cleanup before broader mutation"
else
    fail "ODS uninstaller does not safely integrate managed Pixel cleanup"
fi

write_fixture() {
    rm -rf "$SYSTEMD_DIR" "$ETC_DIR" "$LIBEXEC_DIR" "$HOME_DIR" "$INSTALL_DIR"
    : >"$SYSTEMCTL_LOG"
    mkdir -p \
        "$SYSTEMD_DIR" "$ETC_DIR" "$LIBEXEC_DIR" \
        "$HOME_DIR/.config/ods" "$HOME_DIR/.config/pixel-agent" \
        "$HOME_DIR/.config/pixel-deployment" "$HOME_DIR/.openclaw" \
        "$INSTALL_DIR/extensions/services/pixel-agent/host" \
        "$INSTALL_DIR/extensions/services/pixel-agent/plugin"

    printf '%s\n' 'console.log("managed ingress");' \
        >"$INSTALL_DIR/extensions/services/pixel-agent/host/pixel_ingress.mjs"
    cp "$INSTALL_DIR/extensions/services/pixel-agent/host/pixel_ingress.mjs" \
        "$LIBEXEC_DIR/ods-pixel-ingress.mjs"
    chmod 0755 "$LIBEXEC_DIR/ods-pixel-ingress.mjs"

    cat >"$HOME_DIR/.config/ods/pixel-managed.json" <<JSON
{"schema_version":1,"manager":"ods","state":"ready","install_dir":"$INSTALL_DIR","pixel_source_ref":"d2a2b6be552126f294fb30ee5fb46872acf82c89"}
JSON
    cat >"$HOME_DIR/.openclaw/openclaw.json" <<JSON
{"plugins":{"load":{"paths":["$INSTALL_DIR/extensions/services/pixel-agent/plugin"]}}}
JSON
    printf '%s\n' 'PIXEL_GATEWAY_TOKEN=test-only' >"$HOME_DIR/.config/pixel-agent/gateway.env"
    cat >"$HOME_DIR/.config/pixel-deployment/onboarding.json" <<JSON
{"gatewayExtensions":[{"id":"pixel-ods","path":"$INSTALL_DIR/extensions/services/pixel-agent/plugin"}]}
JSON
    printf '%s\n' 'preserve me' >"$HOME_DIR/.openclaw/openclaw.json.bak"
    chmod 0600 \
        "$HOME_DIR/.config/ods/pixel-managed.json" \
        "$HOME_DIR/.openclaw/openclaw.json" \
        "$HOME_DIR/.config/pixel-agent/gateway.env" \
        "$HOME_DIR/.config/pixel-deployment/onboarding.json"

    cat >"$SYSTEMD_DIR/openclaw-gateway.service" <<UNIT
[Unit]
Description=OpenClaw Gateway - Pixel
[Service]
BindReadOnlyPaths=$INSTALL_DIR/extensions/services/pixel-agent/plugin
UNIT
    cat >"$SYSTEMD_DIR/pixel-ingress.service" <<UNIT
[Unit]
Description=Pixel Agent host ingress (ODS -> Pixel gateway)
[Service]
ExecStart=/usr/bin/env node $LIBEXEC_DIR/ods-pixel-ingress.mjs
EnvironmentFile=$ETC_DIR/pixel-agent.env
UNIT
    cat >"$ETC_DIR/pixel-agent.env" <<'ENV'
PIXEL_INGRESS_SOCKET=/run/ods-pixel/pixel-ingress.sock
PIXEL_GATEWAY_TOKEN_FILE=/run/ods-pixel/openclaw.json
PIXEL_STATUS_FILE=/run/ods-pixel/ods-status.json
ENV
    chmod 0644 "$SYSTEMD_DIR/openclaw-gateway.service" "$SYSTEMD_DIR/pixel-ingress.service"
    chmod 0640 "$ETC_DIR/pixel-agent.env"
}

write_fixture
if ods_pixel_uninstall_managed "$INSTALL_DIR" "$HOME_DIR"; then
    [[ ! -e "$HOME_DIR/.config/ods/pixel-managed.json" \
        && ! -e "$HOME_DIR/.openclaw/openclaw.json" \
        && ! -e "$SYSTEMD_DIR/openclaw-gateway.service" \
        && ! -e "$SYSTEMD_DIR/pixel-ingress.service" \
        && ! -e "$ETC_DIR/pixel-agent.env" \
        && ! -e "$LIBEXEC_DIR/ods-pixel-ingress.mjs" \
        && -e "$HOME_DIR/.openclaw/openclaw.json.bak" ]] \
        && pass "exact ODS-managed Pixel deployment is removed without deleting backups" \
        || fail "managed cleanup left targets or removed an unowned backup"
    if [[ "$(sed -n '1p' "$SYSTEMCTL_LOG")" == "disable --now pixel-ingress.service" \
        && "$(sed -n '2p' "$SYSTEMCTL_LOG")" == "disable --now openclaw-gateway.service" ]]; then
        pass "managed cleanup stops ingress before the gateway"
    else
        fail "managed cleanup did not enforce the exact Pixel service shutdown order"
    fi
else
    fail "valid managed Pixel cleanup failed"
fi

write_fixture
python3 - "$HOME_DIR/.config/ods/pixel-managed.json" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
value = json.loads(path.read_text())
value["install_dir"] = "/tmp/different-ods-install"
path.write_text(json.dumps(value) + "\n")
PY
chmod 0600 "$HOME_DIR/.config/ods/pixel-managed.json"
if ods_pixel_uninstall_managed "$INSTALL_DIR" "$HOME_DIR"; then
    fail "mismatched management marker was accepted"
else
    [[ -e "$HOME_DIR/.openclaw/openclaw.json" && -e "$SYSTEMD_DIR/openclaw-gateway.service" \
        && ! -s "$SYSTEMCTL_LOG" ]] \
        && pass "mismatched marker fails before any mutation" \
        || fail "mismatched marker mutated managed targets"
fi

write_fixture
printf '%s\n' 'drifted program' >"$LIBEXEC_DIR/ods-pixel-ingress.mjs"
chmod 0755 "$LIBEXEC_DIR/ods-pixel-ingress.mjs"
if ods_pixel_uninstall_managed "$INSTALL_DIR" "$HOME_DIR"; then
    fail "drifted root-owned ingress program was accepted"
else
    [[ -e "$HOME_DIR/.config/ods/pixel-managed.json" && -e "$LIBEXEC_DIR/ods-pixel-ingress.mjs" \
        && ! -s "$SYSTEMCTL_LOG" ]] \
        && pass "root artifact drift fails before any mutation" \
        || fail "root artifact drift caused partial cleanup"
fi

write_fixture
chmod 0644 "$HOME_DIR/.config/ods/pixel-managed.json"
if ods_pixel_uninstall_managed "$INSTALL_DIR" "$HOME_DIR"; then
    fail "non-private management marker was accepted"
else
    [[ -e "$HOME_DIR/.config/ods/pixel-managed.json" && -e "$SYSTEMD_DIR/openclaw-gateway.service" \
        && ! -s "$SYSTEMCTL_LOG" ]] \
        && pass "unsafe marker permissions fail before any mutation" \
        || fail "unsafe marker permissions caused partial cleanup"
fi

write_fixture
export SYSTEMCTL_FAIL_DISABLE=true
if ods_pixel_uninstall_managed "$INSTALL_DIR" "$HOME_DIR"; then
    fail "system service stop failure was ignored"
else
    [[ -e "$HOME_DIR/.config/ods/pixel-managed.json" && -e "$HOME_DIR/.openclaw/openclaw.json" \
        && -e "$SYSTEMD_DIR/openclaw-gateway.service" && -e "$LIBEXEC_DIR/ods-pixel-ingress.mjs" ]] \
        && pass "service stop failure leaves every managed artifact in place" \
        || fail "service stop failure caused partial cleanup"
fi
unset SYSTEMCTL_FAIL_DISABLE

write_fixture
rm -f -- "$SYSTEMD_DIR/openclaw-gateway.service" "$SYSTEMD_DIR/pixel-ingress.service" \
    "$ETC_DIR/pixel-agent.env" "$LIBEXEC_DIR/ods-pixel-ingress.mjs"
mv "$MOCK_BIN/sudo" "$MOCK_BIN/sudo.disabled"
if ods_pixel_uninstall_managed "$INSTALL_DIR" "$HOME_DIR"; then
    [[ ! -e "$HOME_DIR/.config/ods/pixel-managed.json" \
        && ! -e "$HOME_DIR/.openclaw/openclaw.json" ]] \
        && pass "owner-only cleanup succeeds without sudo after root artifacts are already absent" \
        || fail "owner-only cleanup left managed user artifacts"
else
    fail "owner-only cleanup unnecessarily required sudo"
fi
mv "$MOCK_BIN/sudo.disabled" "$MOCK_BIN/sudo"

write_fixture
rm -f "$HOME_DIR/.config/ods/pixel-managed.json"
if ods_pixel_uninstall_managed "$INSTALL_DIR" "$HOME_DIR"; then
    [[ -e "$HOME_DIR/.openclaw/openclaw.json" && -e "$SYSTEMD_DIR/openclaw-gateway.service" \
        && ! -s "$SYSTEMCTL_LOG" ]] \
        && pass "ambient Pixel without an ODS marker is untouched" \
        || fail "ambient Pixel was mutated"
else
    fail "ambient Pixel no-op returned failure"
fi

printf 'Results: %d passed, %d failed\n' "$PASS" "$FAIL"
(( FAIL == 0 ))
