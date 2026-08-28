#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=installers/lib/pixel-host-install.sh
source "$ROOT/installers/lib/pixel-host-install.sh"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf 'PASS: %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }
check() { if "$@"; then pass "$*"; else fail "$*"; fi; }

TEST_ROOT="$(mktemp -d)"
cleanup() {
    case "$TEST_ROOT" in /tmp/*|/var/tmp/*) rm -rf -- "$TEST_ROOT" ;; esac
}
trap cleanup EXIT

owner="$(id -un)"
ods_sudo_available() { return 1; }
ai_bad() { :; }
ai_ok() { :; }
ai() { :; }

home="$TEST_ROOT/home"
mkdir -p "$home/.openclaw"
printf '%s\n' '{"gateway":{"bind":"loopback"},"preserve":{"value":7}}' > "$home/.openclaw/openclaw.json"
chmod 0644 "$home/.openclaw/openclaw.json"

_ods_pixel_enable_chat_endpoint "$owner" "$home"
check python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); assert v["gateway"]["http"]["endpoints"]["chatCompletions"]["enabled"] is True; assert v["preserve"]["value"] == 7' "$home/.openclaw/openclaw.json"
check test "$(stat -c '%a' "$home/.openclaw/openclaw.json")" = 600

rm -f "$home/.openclaw/openclaw.json"
printf '%s\n' '{}' > "$TEST_ROOT/symlink-target.json"
ln -s "$TEST_ROOT/symlink-target.json" "$home/.openclaw/openclaw.json"
if _ods_pixel_enable_chat_endpoint "$owner" "$home" >/dev/null 2>&1; then
    fail "symlink OpenClaw config rejected"
else
    pass "symlink OpenClaw config rejected"
fi
rm -f "$home/.openclaw/openclaw.json"

INSTALL_DIR="$TEST_ROOT/ods"
PIXEL_SOURCE_REF="$(printf 'b%.0s' {1..40})"
ODS_PIXEL_GATEWAY_UNIT_PATH="$TEST_ROOT/openclaw-gateway.service"
export INSTALL_DIR PIXEL_SOURCE_REF ODS_PIXEL_GATEWAY_UNIT_PATH
_ods_pixel_assert_managed_state "$owner" "$home"
marker="$home/.config/ods/pixel-managed.json"
check test "$(stat -c '%a' "$marker")" = 600
check python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); assert v == {"install_dir":sys.argv[2],"manager":"ods","pixel_source_ref":sys.argv[3],"schema_version":1,"state":"installing"}' "$marker" "$INSTALL_DIR" "$PIXEL_SOURCE_REF"
_ods_pixel_mark_ready "$owner" "$home"
check python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); assert v["state"] == "ready" and v["pixel_source_ref"] == sys.argv[2]' "$marker" "$PIXEL_SOURCE_REF"
check _ods_pixel_assert_managed_state "$owner" "$home"

ambient_home="$TEST_ROOT/ambient-home"
mkdir -p "$ambient_home/.openclaw"
printf '%s\n' '{}' > "$ambient_home/.openclaw/openclaw.json"
if _ods_pixel_assert_managed_state "$owner" "$ambient_home" >/dev/null 2>&1; then
    fail "ambient OpenClaw deployment rejected"
else
    pass "ambient OpenClaw deployment rejected"
fi
check test ! -e "$ambient_home/.config/ods/pixel-managed.json"

answers="$TEST_ROOT/onboarding.json"
MAX_CONTEXT=32768
LLM_MODEL=qwen-test
LLAMA_REASONING=off
OLLAMA_PORT=11434
SEARXNG_PORT=8888
digest="$(printf 'a%.0s' {1..64})"
_ods_pixel_write_onboarding "$owner" "$home" "$answers" /usr/bin/openclaw /opt/ods/pixel-plugin "$digest"
check python3 -c '
import json,sys
v=json.load(open(sys.argv[1]))
assert v["capabilityProfile"] == "minimal"
assert v["modelBaseUrl"] == "http://127.0.0.1:11434/v1"
assert v["modelId"] == "qwen-test"
assert v["modelContextWindow"] == 32768
assert v["modelMaxTokens"] == 4096
assert v["gatewayExtensions"] == [{"id":"pixel-ods","path":"/opt/ods/pixel-plugin","sha256":"a"*64,"tools":["pixel_ods_status","pixel_ods_apps_list"]}]
assert all(v[name] is False for name in ("emailLimbEnabled","calendarLimbEnabled","socialLimbEnabled","webLimbEnabled","operationsLimbEnabled","frontierLimbEnabled"))
' "$answers"
check test "$(stat -c '%a' "$answers")" = 600

plugin="$ROOT/extensions/services/pixel-agent/plugin"
check node --check "$plugin/index.js"
check node --check "$plugin/projection.mjs"
check python3 -c '
import json,sys
p=json.load(open(sys.argv[1])); m=json.load(open(sys.argv[2]))
assert p["type"] == "module" and p["openclaw"]["extensions"] == ["./index.js"]
assert "dependencies" not in p
assert sorted(m["contracts"]["tools"]) == ["pixel_ods_apps_list","pixel_ods_status"]
' "$plugin/package.json" "$plugin/openclaw.plugin.json"
# Dollar expressions below are literal source-code assertions.
# shellcheck disable=SC2016
check python3 -c '
import pathlib,sys
text=pathlib.Path(sys.argv[1]).read_text()
assert "ods_pixel_run_as_owner \"$owner\" \"$home\" curl" in text
assert text.index("http://localhost/health >/dev/null") < text.index("_ods_pixel_mark_ready \"$owner\" \"$home\"")
' "$ROOT/installers/lib/pixel-host-install.sh"

printf '\nResults: %d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
