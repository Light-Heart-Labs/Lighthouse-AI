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
DOCKER_LOG="$TEST_ROOT/docker.log"
DOCKER_STATE="$TEST_ROOT/docker-live-state"
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
cat >"$MOCK_BIN/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DOCKER_LOG"
image_id="sha256:$(printf 'd%.0s' {1..64})"
container_id="$(printf 'e%.0s' {1..64})"
case "${1:-} ${2:-}" in
    "image inspect")
        reference="${*: -1}"
        if [[ "$reference" == openclaw-sandbox:test && ! -e "$DOCKER_STATE" ]]; then
            exit 1
        fi
        if [[ " $* " == *" --format "* ]]; then
            printf '%s|4.3.14|%s|sandbox\n' "$image_id" "$(id -u)"
        else
            printf '%s\n' '[]'
        fi
        ;;
    "image rm")
        rm -f -- "$DOCKER_STATE"
        ;;
    "ps -aq")
        printf '%s\n' "$container_id"
        ;;
    "inspect --format")
        printf '/pixel-sbx-agent-pixel-test|1|agent:pixel|%s\n' "$image_id"
        ;;
    "rm -f") ;;
    *) exit 1 ;;
esac
SH
chmod +x "$MOCK_BIN/sudo" "$MOCK_BIN/systemctl" "$MOCK_BIN/docker"
export PATH="$MOCK_BIN:$PATH" SYSTEMCTL_LOG DOCKER_LOG DOCKER_STATE
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

if python3 - "$ROOT_DIR/install-core.sh" "$ROOT_DIR/installers/phases/06-directories.sh" <<'PY'
import pathlib
import sys

core = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
phase = pathlib.Path(sys.argv[2]).read_text(encoding="utf-8")
hook = 'ods_pixel_uninstall_managed "$INSTALL_DIR" "$HOME"'
assert 'source "$SCRIPT_DIR/lib/pixel-uninstall.sh"' in core
assert '"${ENABLE_PIXEL_RUNTIME:-false}" != "true"' in phase
assert hook in phase
assert phase.index(hook) < phase.index('_phase06_step "copy-source"')
assert '_ods_pixel_source_transition_required' in phase
assert '_phase06_step "rebind-pixel-source"' in phase
assert phase.index('_phase06_step "rebind-pixel-source"') < phase.index('_phase06_step "copy-source"')
PY
then
    pass "Pixel reruns retire disabled or superseded managed host runtimes before source replacement"
else
    fail "Pixel rerun does not safely deactivate managed host runtime before source replacement"
fi

if logger_output="$(bash -c '
    unset -f log_info log_ok log_error 2>/dev/null || true
    source "$1"
    declare -F log_info log_ok log_error >/dev/null
    ods_pixel_uninstall_managed relative-path /tmp
' _ "$ROOT_DIR/lib/pixel-uninstall.sh" 2>&1)"; then
    fail "Pixel uninstall unexpectedly accepted an invalid install directory"
elif [[ "$logger_output" == *"Refusing Pixel cleanup for an invalid ODS install directory"* \
    && "$logger_output" != *"command not found"* ]]; then
    pass "Pixel uninstall supplies safe fallback logging for install-core callers"
else
    fail "Pixel uninstall fallback logging is unavailable"
fi

write_fixture() {
    rm -rf "$SYSTEMD_DIR" "$ETC_DIR" "$LIBEXEC_DIR" "$HOME_DIR" "$INSTALL_DIR"
    : >"$SYSTEMCTL_LOG"
    : >"$DOCKER_LOG"
    rm -f -- "$DOCKER_STATE"
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

write_active_fixture() {
    write_fixture
    local pixel_install="$HOME_DIR/.local/share/pixel"
    local exec_control="$HOME_DIR/.openclaw/.ods-exec-control"
    local release="$pixel_install/releases/4.3.14"
    local source_ref="d2a2b6be552126f294fb30ee5fb46872acf82c89"
    local source_tree image_id
    source_tree="$(printf 'a%.0s' {1..40})"
    image_id="sha256:$(printf 'd%.0s' {1..64})"
    mkdir -m 0700 "$exec_control"
    printf '%s\n' '#!/bin/sh' >"$exec_control/cancellable-exec.sh"
    chmod 0500 "$exec_control/cancellable-exec.sh"
    : >"$exec_control/$(printf 'e%.0s' {1..64}).cancel"
    chmod 0600 "$exec_control/$(printf 'e%.0s' {1..64}).cancel"
    mkdir -p "$release"
    cat >"$release/release-identity.json" <<JSON
{"kind":"pixel-release-source-identity","pixel":"4.3.14","source":{"state":"git-clean","commit":"$source_ref","tree":"$source_tree"}}
JSON
    printf '%s  %s\n' "$(sha256sum "$release/release-identity.json" | awk '{print $1}')" release-identity.json \
        >"$release/install-manifest.sha256"
    local identity_sha256 manifest_sha256 config_sha256 contract_sha256
    identity_sha256="$(sha256sum "$release/release-identity.json" | awk '{print $1}')"
    manifest_sha256="$(sha256sum "$release/install-manifest.sha256" | awk '{print $1}')"
    cat >"$pixel_install/runtime-attestation.json" <<JSON
{"kind":"pixel-runtime-attestation","status":"verified","pixel":"4.3.14","source":{"state":"git-clean","commit":"$source_ref","tree":"$source_tree"},"release":{"sourceIdentitySha256":"$identity_sha256","installManifestSha256":"$manifest_sha256"}}
JSON
    chmod 0600 "$pixel_install/runtime-attestation.json"
    : >"$pixel_install/.deployment.lock"
    chmod 0600 "$pixel_install/.deployment.lock"
    ln -s "$release" "$pixel_install/current"
    config_sha256="$(python3 - "$HOME_DIR/.openclaw/openclaw.json" <<'PY'
import hashlib, json, pathlib, sys
value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
canonical = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
print(hashlib.sha256(b"ods-pixel-openclaw-v1\0" + canonical).hexdigest())
PY
)"
    contract_sha256="$(python3 - "$HOME_DIR/.config/pixel-deployment/onboarding.json" <<'PY'
import hashlib, pathlib, sys
print(hashlib.sha256(b"ods-pixel-contract-v1\0" + pathlib.Path(sys.argv[1]).read_bytes()).hexdigest())
PY
)"
    cat >"$HOME_DIR/.config/ods/pixel-managed.json" <<JSON
{"schema_version":2,"manager":"ods","state":"ready","initial_active_state":"absent","install_dir":"$INSTALL_DIR","pixel_source_ref":"$source_ref","contract_sha256":"$contract_sha256","configuration_sha256":"$config_sha256","active_release_version":"4.3.14","release_identity_sha256":"$identity_sha256","install_manifest_sha256":"$manifest_sha256","sandbox_image":"openclaw-sandbox:test","sandbox_image_id":"$image_id"}
JSON
    chmod 0600 "$HOME_DIR/.config/ods/pixel-managed.json"
    : >"$DOCKER_STATE"
    : >"$DOCKER_LOG"
}

write_fixture
rm -f -- "$SYSTEMD_DIR/openclaw-gateway.service" "$SYSTEMD_DIR/pixel-ingress.service" \
    "$ETC_DIR/pixel-agent.env" "$LIBEXEC_DIR/ods-pixel-ingress.mjs" \
    "$HOME_DIR/.config/pixel-agent/gateway.env"
cat >"$HOME_DIR/.config/ods/pixel-managed.json" <<JSON
{"schema_version":2,"manager":"ods","state":"installing","initial_active_state":"absent","install_dir":"$INSTALL_DIR","pixel_source_ref":"d2a2b6be552126f294fb30ee5fb46872acf82c89"}
JSON
cat >"$HOME_DIR/.openclaw/openclaw.json" <<'JSON'
{"gateway":{"http":{"endpoints":{"chatCompletions":{"enabled":true}}}}}
JSON
chmod 0600 "$HOME_DIR/.config/ods/pixel-managed.json" "$HOME_DIR/.openclaw/openclaw.json"
if ods_pixel_uninstall_managed "$INSTALL_DIR" "$HOME_DIR"; then
    [[ ! -e "$HOME_DIR/.config/ods/pixel-managed.json" \
        && ! -e "$HOME_DIR/.openclaw/openclaw.json" \
        && ! -e "$HOME_DIR/.config/pixel-deployment/onboarding.json" \
        && ! -s "$SYSTEMCTL_LOG" ]] \
        && pass "failed pre-apply Pixel bootstrap state is removed without claiming an ambient config" \
        || fail "failed pre-apply Pixel cleanup left managed state or touched system services"
else
    fail "failed pre-apply Pixel bootstrap state could not be cleaned"
fi

write_fixture
rm -f -- "$SYSTEMD_DIR/openclaw-gateway.service" "$SYSTEMD_DIR/pixel-ingress.service" \
    "$ETC_DIR/pixel-agent.env" "$LIBEXEC_DIR/ods-pixel-ingress.mjs" \
    "$HOME_DIR/.config/pixel-agent/gateway.env"
cat >"$HOME_DIR/.config/ods/pixel-managed.json" <<JSON
{"schema_version":2,"manager":"ods","state":"installing","initial_active_state":"absent","install_dir":"$INSTALL_DIR","pixel_source_ref":"d2a2b6be552126f294fb30ee5fb46872acf82c89"}
JSON
cat >"$HOME_DIR/.openclaw/openclaw.json" <<'JSON'
{"gateway":{"http":{"endpoints":{"chatCompletions":{"enabled":true}}}},"ambient":true}
JSON
chmod 0600 "$HOME_DIR/.config/ods/pixel-managed.json" "$HOME_DIR/.openclaw/openclaw.json"
if ods_pixel_uninstall_managed "$INSTALL_DIR" "$HOME_DIR"; then
    fail "modified pre-apply OpenClaw config was claimed by ODS cleanup"
else
    [[ -e "$HOME_DIR/.config/ods/pixel-managed.json" \
        && -e "$HOME_DIR/.openclaw/openclaw.json" && ! -s "$SYSTEMCTL_LOG" ]] \
        && pass "modified pre-apply OpenClaw config remains fail-closed" \
        || fail "modified pre-apply cleanup refusal caused mutation"
fi

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
rm -f -- "$SYSTEMD_DIR/pixel-ingress.service" "$ETC_DIR/pixel-agent.env" \
    "$LIBEXEC_DIR/ods-pixel-ingress.mjs"
if ods_pixel_uninstall_managed "$INSTALL_DIR" "$HOME_DIR"; then
    if [[ "$(sed -n '1p' "$SYSTEMCTL_LOG")" == "disable --now openclaw-gateway.service" \
        && "$(grep -c '^disable --now pixel-ingress.service$' "$SYSTEMCTL_LOG" || true)" == 0 \
        && ! -e "$HOME_DIR/.config/ods/pixel-managed.json" \
        && ! -e "$SYSTEMD_DIR/openclaw-gateway.service" ]]; then
        pass "interrupted first install with no ingress unit is safely removed"
    else
        fail "gateway-only interrupted install cleanup was incomplete or touched absent ingress"
    fi
else
    fail "interrupted first install with no ingress unit could not be cleaned"
fi

write_active_fixture
if ods_pixel_uninstall_managed "$INSTALL_DIR" "$HOME_DIR"; then
    pixel_install="$HOME_DIR/.local/share/pixel"
    shopt -s nullglob
    retired_release_matches=("$pixel_install"/retired-ods-releases/4.3.14-*.????????/release)
    shopt -u nullglob
    [[ ! -e "$pixel_install/current" && ! -L "$pixel_install/current" \
        && ! -e "$pixel_install/runtime-attestation.json" \
        && ! -e "$pixel_install/.ods-uninstall-current" \
        && ! -e "$pixel_install/.ods-uninstall-runtime-attestation" \
        && ! -e "$pixel_install/releases/4.3.14" \
        && ${#retired_release_matches[@]} -eq 1 \
        && -f "${retired_release_matches[0]}/release-identity.json" \
        && "$(stat -c '%a' "$pixel_install/retired-ods-releases")" == 700 \
        && -f "$pixel_install/.deployment.lock" \
        && ! -e "$HOME_DIR/.config/ods/pixel-managed.json" \
        && ! -e "$HOME_DIR/.openclaw/.ods-exec-control" \
        && ! -e "$DOCKER_STATE" ]] \
        && pass "fully bound ODS Pixel is deactivated while its exact release is privately retired" \
        || fail "fully bound ODS Pixel active-state cleanup was incomplete or over-broad"
    grep -Fq 'rm -f' "$DOCKER_LOG" \
        && grep -Fq 'image rm -- openclaw-sandbox:test' "$DOCKER_LOG" \
        && pass "managed sandbox containers and exact live tag are retired" \
        || fail "managed Pixel Docker state was not retired exactly"
else
    fail "fully bound ODS Pixel active state was not safely deactivated"
fi

write_active_fixture
printf '%s\n' 'unexpected' >"$HOME_DIR/.openclaw/.ods-exec-control/unowned-artifact"
chmod 0600 "$HOME_DIR/.openclaw/.ods-exec-control/unowned-artifact"
if ods_pixel_uninstall_managed "$INSTALL_DIR" "$HOME_DIR"; then
    fail "unexpected Pixel execution-control artifact was accepted"
else
    [[ -L "$HOME_DIR/.local/share/pixel/current" \
        && -e "$HOME_DIR/.config/ods/pixel-managed.json" \
        && -e "$HOME_DIR/.openclaw/.ods-exec-control/unowned-artifact" \
        && ! -s "$SYSTEMCTL_LOG" && ! -s "$DOCKER_LOG" ]] \
        && pass "unsafe Pixel execution-control drift fails before service or Docker mutation" \
        || fail "execution-control cleanup refusal caused partial mutation"
fi

write_active_fixture
chmod 0500 "$HOME_DIR/.openclaw/.ods-exec-control"
if ods_pixel_uninstall_managed "$INSTALL_DIR" "$HOME_DIR"; then
    fail "non-writable Pixel execution-control root was accepted"
else
    [[ -L "$HOME_DIR/.local/share/pixel/current" \
        && -e "$HOME_DIR/.config/ods/pixel-managed.json" \
        && -e "$HOME_DIR/.openclaw/.ods-exec-control/cancellable-exec.sh" \
        && ! -s "$SYSTEMCTL_LOG" && ! -s "$DOCKER_LOG" ]] \
        && pass "non-writable execution-control root fails before mutation" \
        || fail "execution-control mode refusal caused partial mutation"
fi
chmod 0700 "$HOME_DIR/.openclaw/.ods-exec-control"

write_active_fixture
printf '%s\n' '{"tampered":true}' >"$HOME_DIR/.local/share/pixel/runtime-attestation.json"
chmod 0600 "$HOME_DIR/.local/share/pixel/runtime-attestation.json"
if ods_pixel_uninstall_managed "$INSTALL_DIR" "$HOME_DIR"; then
    fail "tampered active Pixel attestation was accepted"
else
    [[ -L "$HOME_DIR/.local/share/pixel/current" \
        && -e "$HOME_DIR/.config/ods/pixel-managed.json" \
        && ! -s "$SYSTEMCTL_LOG" && ! -s "$DOCKER_LOG" ]] \
        && pass "tampered active Pixel attestation fails before service or Docker mutation" \
        || fail "tampered active Pixel attestation caused partial cleanup"
fi

write_active_fixture
mv -T "$HOME_DIR/.local/share/pixel/runtime-attestation.json" \
    "$HOME_DIR/.local/share/pixel/.ods-uninstall-runtime-attestation"
mv -T "$HOME_DIR/.local/share/pixel/current" \
    "$HOME_DIR/.local/share/pixel/.ods-uninstall-current"
if ods_pixel_uninstall_managed "$INSTALL_DIR" "$HOME_DIR"; then
    [[ ! -e "$HOME_DIR/.local/share/pixel/.ods-uninstall-current" \
        && ! -e "$HOME_DIR/.local/share/pixel/.ods-uninstall-runtime-attestation" \
        && ! -e "$DOCKER_STATE" ]] \
        && pass "interrupted staged Pixel deactivation resumes to a clean inactive state" \
        || fail "staged Pixel deactivation did not reconcile exactly"
else
    fail "staged Pixel deactivation could not resume safely"
fi

for interrupted_step in attestation link; do
    write_active_fixture
    if [[ "$interrupted_step" == attestation ]]; then
        mv -T "$HOME_DIR/.local/share/pixel/runtime-attestation.json" \
            "$HOME_DIR/.local/share/pixel/.ods-uninstall-runtime-attestation"
    else
        mv -T "$HOME_DIR/.local/share/pixel/current" \
            "$HOME_DIR/.local/share/pixel/.ods-uninstall-current"
    fi
    if ods_pixel_uninstall_managed "$INSTALL_DIR" "$HOME_DIR" \
        && [[ ! -e "$HOME_DIR/.local/share/pixel/current" \
            && ! -e "$HOME_DIR/.local/share/pixel/runtime-attestation.json" \
            && ! -e "$HOME_DIR/.local/share/pixel/.ods-uninstall-current" \
            && ! -e "$HOME_DIR/.local/share/pixel/.ods-uninstall-runtime-attestation" \
            && ! -e "$DOCKER_STATE" ]]; then
        pass "deactivation resumes after only the $interrupted_step move completed"
    else
        fail "deactivation could not resume after the $interrupted_step move"
    fi
done

for archive_step in before-release-move after-release-move after-active-state-cleanup; do
    write_active_fixture
    pixel_install="$HOME_DIR/.local/share/pixel"
    mv -T "$pixel_install/runtime-attestation.json" \
        "$pixel_install/.ods-uninstall-runtime-attestation"
    mv -T "$pixel_install/current" "$pixel_install/.ods-uninstall-current"
    mkdir -m 0700 "$pixel_install/retired-ods-releases"
    identity_prefix="$(python3 - "$HOME_DIR/.config/ods/pixel-managed.json" <<'PY'
import json, pathlib, sys
print(json.loads(pathlib.Path(sys.argv[1]).read_text())["release_identity_sha256"][:12])
PY
)"
    retired_container="$(mktemp -d \
        "$pixel_install/retired-ods-releases/4.3.14-${identity_prefix}.XXXXXXXX")"
    retired_release="$retired_container/release"
    python3 - "$HOME_DIR/.config/ods/pixel-managed.json" "$retired_release" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
value = json.loads(path.read_text())
value["state"] = "deactivating"
value["retired_release_path"] = sys.argv[2]
path.write_text(json.dumps(value) + "\n")
PY
    chmod 0600 "$HOME_DIR/.config/ods/pixel-managed.json"
    if [[ "$archive_step" != before-release-move ]]; then
        mv -T "$pixel_install/releases/4.3.14" "$retired_release"
    fi
    if [[ "$archive_step" == after-active-state-cleanup ]]; then
        rm -f -- "$pixel_install/.ods-uninstall-current" \
            "$pixel_install/.ods-uninstall-runtime-attestation" \
            "$HOME_DIR/.openclaw/openclaw.json" \
            "$HOME_DIR/.config/pixel-agent/gateway.env" \
            "$HOME_DIR/.config/pixel-deployment/onboarding.json"
    fi
    if ods_pixel_uninstall_managed "$INSTALL_DIR" "$HOME_DIR" \
        && [[ -d "$retired_release" \
            && ! -e "$pixel_install/releases/4.3.14" \
            && ! -e "$pixel_install/.ods-uninstall-current" \
            && ! -e "$pixel_install/.ods-uninstall-runtime-attestation" \
            && ! -e "$HOME_DIR/.config/ods/pixel-managed.json" \
            && ! -e "$DOCKER_STATE" ]]; then
        pass "deactivation resumes from $archive_step archive state"
    else
        fail "deactivation could not resume from $archive_step archive state"
    fi
done

write_active_fixture
mkdir -m 0770 "$HOME_DIR/.local/share/pixel/retired-ods-releases"
if ods_pixel_uninstall_managed "$INSTALL_DIR" "$HOME_DIR"; then
    fail "unsafe retired release root was accepted"
else
    [[ -L "$HOME_DIR/.local/share/pixel/current" \
        && -e "$HOME_DIR/.config/ods/pixel-managed.json" \
        && -e "$DOCKER_STATE" && ! -s "$SYSTEMCTL_LOG" && ! -s "$DOCKER_LOG" ]] \
        && pass "unsafe retired release root fails before service or Docker mutation" \
        || fail "unsafe retired release root caused partial cleanup"
fi

write_active_fixture
python3 - "$HOME_DIR/.config/ods/pixel-managed.json" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
value = json.loads(path.read_text())
value["schema_version"] = 1
value.pop("initial_active_state", None)
path.write_text(json.dumps(value) + "\n")
PY
chmod 0600 "$HOME_DIR/.config/ods/pixel-managed.json"
if ods_pixel_uninstall_managed "$INSTALL_DIR" "$HOME_DIR"; then
    fail "legacy marker without a pre-install absence proof deactivated Pixel"
else
    [[ -L "$HOME_DIR/.local/share/pixel/current" && -e "$DOCKER_STATE" \
        && ! -s "$SYSTEMCTL_LOG" && ! -s "$DOCKER_LOG" ]] \
        && pass "legacy marker cannot claim or deactivate an active Pixel release" \
        || fail "legacy marker active-state refusal caused mutation"
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
