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
check test "$(stat -c '%a' "${marker%/*}")" = 700
check python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); assert v == {"initial_active_state":"absent","install_dir":sys.argv[2],"manager":"ods","pixel_source_ref":sys.argv[3],"schema_version":2,"state":"installing"}' "$marker" "$INSTALL_DIR" "$PIXEL_SOURCE_REF"
if _ods_pixel_source_transition_required "$owner" "$home" "$PIXEL_SOURCE_REF"; then
    fail "matching Pixel source unexpectedly requires retirement"
else
    check test "$?" = 1
fi
next_source_ref="$(printf 'c%.0s' {1..40})"
check _ods_pixel_source_transition_required "$owner" "$home" "$next_source_ref"
python3 - "$marker" "$next_source_ref" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
value = json.loads(path.read_text(encoding="utf-8"))
value["requested_source_ref"] = sys.argv[2]
path.write_text(json.dumps(value) + "\n", encoding="utf-8")
PY
chmod 0600 "$marker"
check _ods_pixel_source_transition_required "$owner" "$home" "$next_source_ref"
python3 - "$marker" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
value = json.loads(path.read_text(encoding="utf-8"))
value.pop("requested_source_ref", None)
path.write_text(json.dumps(value) + "\n", encoding="utf-8")
PY
chmod 0600 "$marker"
printf '%s\n' '{"gateway":{"http":{"endpoints":{"chatCompletions":{"enabled":true}}}}}' > "$home/.openclaw/openclaw.json"
chmod 0600 "$home/.openclaw/openclaw.json"
contract_sha256="$(printf 'c%.0s' {1..64})"
pixel_root="$TEST_ROOT/pixel-root"
release="$home/.local/share/pixel/releases/4.3.14"
mkdir -p "$pixel_root" "$release"
printf '%s\n' '{"sandboxImage":"openclaw-sandbox:test"}' > "$pixel_root/RELEASE-MANIFEST.json"
cat > "$release/release-identity.json" <<JSON
{"kind":"pixel-release-source-identity","pixel":"4.3.14","source":{"state":"git-clean","commit":"$PIXEL_SOURCE_REF","tree":"$(printf 'a%.0s' {1..40})"}}
JSON
printf '%s  %s\n' "$(sha256sum "$release/release-identity.json" | awk '{print $1}')" release-identity.json > "$release/install-manifest.sha256"
identity_sha256="$(sha256sum "$release/release-identity.json" | awk '{print $1}')"
manifest_sha256="$(sha256sum "$release/install-manifest.sha256" | awk '{print $1}')"
cat > "$home/.local/share/pixel/runtime-attestation.json" <<JSON
{"kind":"pixel-runtime-attestation","status":"verified","pixel":"4.3.14","source":{"state":"git-clean","commit":"$PIXEL_SOURCE_REF","tree":"$(printf 'a%.0s' {1..40})"},"release":{"sourceIdentitySha256":"$identity_sha256","installManifestSha256":"$manifest_sha256"}}
JSON
chmod 0600 "$home/.local/share/pixel/runtime-attestation.json"
ln -s "$release" "$home/.local/share/pixel/current"
mock_bin="$TEST_ROOT/mock-bin"
mkdir -p "$mock_bin"
cat > "$mock_bin/docker" <<SH
#!/usr/bin/env bash
if [[ "\$1 \$2" == "image inspect" ]]; then
    printf '%s\n' 'sha256:$(printf 'd%.0s' {1..64})'
    exit 0
fi
exit 1
SH
chmod +x "$mock_bin/docker"
PATH="$mock_bin:$PATH"
export PATH
_ods_pixel_mark_verified_installing "$owner" "$home" "$contract_sha256" "$pixel_root"
check python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); assert v["state"] == "installing" and v["pixel_source_ref"] == sys.argv[2] and v["contract_sha256"] == sys.argv[3] and len(v["configuration_sha256"]) == 64 and v["active_release_version"] == "4.3.14" and len(v["release_identity_sha256"]) == 64 and len(v["install_manifest_sha256"]) == 64 and v["sandbox_image"] == "openclaw-sandbox:test" and v["sandbox_image_id"].startswith("sha256:")' "$marker" "$PIXEL_SOURCE_REF" "$contract_sha256"
check _ods_pixel_managed_contract_matches "$owner" "$home" "$contract_sha256"
check _ods_pixel_verified_source_matches "$owner" "$home"
_ods_pixel_mark_ready "$owner" "$home" "$contract_sha256" "$pixel_root"
check python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); assert v["state"] == "ready" and v["pixel_source_ref"] == sys.argv[2] and v["contract_sha256"] == sys.argv[3] and len(v["configuration_sha256"]) == 64' "$marker" "$PIXEL_SOURCE_REF" "$contract_sha256"
check _ods_pixel_managed_contract_matches "$owner" "$home" "$contract_sha256"
if _ods_pixel_managed_contract_matches "$owner" "$home" "$(printf 'd%.0s' {1..64})"; then
    fail "mismatched managed Pixel contract rejected"
else
    pass "mismatched managed Pixel contract rejected"
fi
original_source_ref="$PIXEL_SOURCE_REF"
PIXEL_SOURCE_REF="$(printf 'e%.0s' {1..40})"
if _ods_pixel_managed_contract_matches "$owner" "$home" "$contract_sha256"; then
    fail "mismatched exact Pixel source commit rejected"
else
    pass "mismatched exact Pixel source commit rejected"
fi
if _ods_pixel_verified_source_matches "$owner" "$home"; then
    fail "mismatched verified Pixel source rejected for extension refresh"
else
    pass "mismatched verified Pixel source rejected for extension refresh"
fi
_ods_pixel_mark_installing "$owner" "$home"
check python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); assert v["pixel_source_ref"] == sys.argv[2] and v["requested_source_ref"] == sys.argv[3] and v["state"] == "installing"' "$marker" "$original_source_ref" "$PIXEL_SOURCE_REF"
PIXEL_SOURCE_REF="$original_source_ref"
chmod 0644 "$marker"
if _ods_pixel_managed_contract_matches "$owner" "$home" "$contract_sha256"; then
    fail "unsafe managed Pixel marker mode rejected"
else
    pass "unsafe managed Pixel marker mode rejected"
fi
chmod 0600 "$marker"
cp "$home/.openclaw/openclaw.json" "$TEST_ROOT/openclaw.valid.json"
printf '%s\n' '{"gateway":{"http":{"endpoints":{"chatCompletions":{"enabled":false}}}}}' > "$home/.openclaw/openclaw.json"
if _ods_pixel_managed_contract_matches "$owner" "$home" "$contract_sha256"; then
    fail "drifted managed OpenClaw configuration rejected"
else
    pass "drifted managed OpenClaw configuration rejected"
fi
mv "$TEST_ROOT/openclaw.valid.json" "$home/.openclaw/openclaw.json"
candidate="$TEST_ROOT/openclaw.candidate.json"
printf '%s\n' '{"gateway":{"http":{"endpoints":{"chatCompletions":{"enabled":true}}}}}' > "$candidate"
chmod 0600 "$candidate"
check _ods_pixel_candidate_config_matches_live "$owner" "$home" "$candidate"
printf '%s\n' '{"gateway":{"http":{"endpoints":{"chatCompletions":{"enabled":false}}}}}' > "$candidate"
if _ods_pixel_candidate_config_matches_live "$owner" "$home" "$candidate"; then
    fail "drifted Pixel candidate config rejected"
else
    pass "drifted Pixel candidate config rejected"
fi
rm -f "$candidate"
ln -s "$home/.openclaw/openclaw.json" "$candidate"
if _ods_pixel_candidate_config_matches_live "$owner" "$home" "$candidate"; then
    fail "symlink Pixel candidate config rejected"
else
    pass "symlink Pixel candidate config rejected"
fi
rm -f "$candidate"
check _ods_pixel_assert_managed_state "$owner" "$home"
_ods_pixel_mark_installing "$owner" "$home"
check python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); assert v["state"] == "installing" and v["pixel_source_ref"] == sys.argv[2] and v["contract_sha256"] == sys.argv[3]' "$marker" "$PIXEL_SOURCE_REF" "$contract_sha256"
check _ods_pixel_managed_contract_matches "$owner" "$home" "$contract_sha256"
_ods_pixel_mark_ready "$owner" "$home" "$contract_sha256" "$pixel_root"

ambient_home="$TEST_ROOT/ambient-home"
mkdir -p "$ambient_home/.openclaw"
printf '%s\n' '{}' > "$ambient_home/.openclaw/openclaw.json"
if _ods_pixel_assert_managed_state "$owner" "$ambient_home" >/dev/null 2>&1; then
    fail "ambient OpenClaw deployment rejected"
else
    pass "ambient OpenClaw deployment rejected"
fi
check test ! -e "$ambient_home/.config/ods/pixel-managed.json"

ambient_active_home="$TEST_ROOT/ambient-active-home"
mkdir -p "$ambient_active_home/.local/share/pixel/releases/4.3.14"
ln -s "$ambient_active_home/.local/share/pixel/releases/4.3.14" "$ambient_active_home/.local/share/pixel/current"
if _ods_pixel_assert_managed_state "$owner" "$ambient_active_home" >/dev/null 2>&1; then
    fail "ambient active Pixel release rejected before marker creation"
else
    pass "ambient active Pixel release rejected before marker creation"
fi
check test ! -e "$ambient_active_home/.config/ods/pixel-managed.json"

plugin_tree="$INSTALL_DIR/extensions/services/pixel-agent/plugin"
mkdir -p "$plugin_tree/nested"
printf '%s\n' '{"id":"pixel-ods"}' > "$plugin_tree/openclaw.plugin.json"
printf '%s\n' 'export default {};' > "$plugin_tree/nested/index.js"
chmod 0777 "$INSTALL_DIR" "$INSTALL_DIR/extensions" "$INSTALL_DIR/extensions/services" \
    "$INSTALL_DIR/extensions/services/pixel-agent" "$plugin_tree" \
    "$plugin_tree/nested" "$plugin_tree/openclaw.plugin.json" "$plugin_tree/nested/index.js"
check _ods_pixel_secure_plugin_tree "$owner" "$home" "$plugin_tree"
check test -z "$(find -P "$plugin_tree" -perm /022 -print -quit)"
check test "$(stat -c '%a' "$INSTALL_DIR")" = 755
check test "$(stat -c '%a' "$plugin_tree")" = 755
check test "$(stat -c '%a' "$plugin_tree/nested/index.js")" = 644
ln -s "$plugin_tree/openclaw.plugin.json" "$plugin_tree/linked.json"
if _ods_pixel_secure_plugin_tree "$owner" "$home" "$plugin_tree" >/dev/null 2>&1; then
    fail "symlink in ODS Pixel plugin tree rejected"
else
    pass "symlink in ODS Pixel plugin tree rejected"
fi
rm -f "$plugin_tree/linked.json"

exec_control_home="$TEST_ROOT/exec-control-home"
exec_control_source="$TEST_ROOT/cancellable-exec.sh"
install -m 0644 "$ROOT/extensions/services/pixel-agent/host/cancellable-exec.sh" \
    "$exec_control_source"
mkdir -m 0700 -p "$exec_control_home/.openclaw"
check _ods_pixel_install_exec_control "$owner" "$exec_control_home" \
    "$exec_control_source"
check test "$(stat -c '%a' "$exec_control_home/.openclaw/.ods-exec-control")" = 700
check test "$(stat -c '%a' "$exec_control_home/.openclaw/.ods-exec-control/cancellable-exec.sh")" = 500
exec_control_bad_home="$TEST_ROOT/exec-control-bad-home"
mkdir -m 0700 -p "$exec_control_bad_home/.openclaw" "$TEST_ROOT/exec-control-link-target"
ln -s "$TEST_ROOT/exec-control-link-target" \
    "$exec_control_bad_home/.openclaw/.ods-exec-control"
if _ods_pixel_install_exec_control "$owner" "$exec_control_bad_home" \
    "$exec_control_source" >/dev/null 2>&1; then
    fail "symlink Pixel execution control root rejected"
else
    pass "symlink Pixel execution control root rejected"
fi
exec_control_bad_wrapper_home="$TEST_ROOT/exec-control-bad-wrapper-home"
mkdir -m 0700 -p "$exec_control_bad_wrapper_home/.openclaw/.ods-exec-control"
ln -s "$TEST_ROOT/exec-control-link-target" \
    "$exec_control_bad_wrapper_home/.openclaw/.ods-exec-control/cancellable-exec.sh"
if _ods_pixel_install_exec_control "$owner" "$exec_control_bad_wrapper_home" \
    "$exec_control_source" >/dev/null 2>&1; then
    fail "symlink Pixel execution wrapper rejected"
else
    pass "symlink Pixel execution wrapper rejected"
fi

plugin_list_bin="$TEST_ROOT/openclaw-plugin-list"
cat > "$plugin_list_bin" <<SH
#!/usr/bin/env bash
printf '%s\n' '{"plugins":[{"id":"pixel-ods","status":"loaded","rootDir":"$plugin_tree","contracts":{"tools":["pixel_ods_status","pixel_ods_apps_list","pixel_ods_web_extract"]}}]}'
SH
chmod 0755 "$plugin_list_bin"
check _ods_pixel_verify_plugin_loaded "$owner" "$home" "$plugin_list_bin" "$plugin_tree"
cat > "$plugin_list_bin" <<SH
#!/usr/bin/env bash
printf '%s\n' '{"plugins":[{"id":"pixel-ods","status":"blocked","rootDir":"$plugin_tree","contracts":{"tools":["pixel_ods_status","pixel_ods_apps_list","pixel_ods_web_extract"]}}]}'
SH
if _ods_pixel_verify_plugin_loaded "$owner" "$home" "$plugin_list_bin" "$plugin_tree" >/dev/null 2>&1; then
    fail "blocked ODS Pixel plugin rejected"
else
    pass "blocked ODS Pixel plugin rejected"
fi

plugin_registry_bin="$TEST_ROOT/openclaw-plugin-registry"
cat > "$plugin_registry_bin" <<SH
#!/usr/bin/env bash
printf '%s\n' '{"refreshed":true,"registry":{"version":1,"refreshReason":"manual","plugins":[{"pluginId":"pixel-ods","enabled":true,"rootDir":"$plugin_tree","contributions":{"contracts":{"tools":["pixel_ods_apps_list","pixel_ods_status","pixel_ods_web_extract"]}}}]}}'
SH
chmod 0755 "$plugin_registry_bin"
check _ods_pixel_refresh_plugin_registry "$owner" "$home" "$plugin_registry_bin" "$plugin_tree"
cat > "$plugin_registry_bin" <<SH
#!/usr/bin/env bash
printf '%s\n' '{"refreshed":true,"registry":{"version":1,"refreshReason":"manual","plugins":[{"pluginId":"pixel-ods","enabled":true,"rootDir":"$plugin_tree","contributions":{"contracts":{"tools":["pixel_ods_status"]}}}]}}'
SH
if _ods_pixel_refresh_plugin_registry "$owner" "$home" "$plugin_registry_bin" "$plugin_tree" >/dev/null 2>&1; then
    fail "stale ODS Pixel plugin registry rejected"
else
    pass "stale ODS Pixel plugin registry rejected"
fi

restart_probe="$TEST_ROOT/restart-probe"
mkdir -p "$restart_probe/pixel-root"
if (
    restart_state="$restart_probe/state"
    systemctl() {
        if [[ "$1" == show ]]; then
            if [[ -e "$restart_state" ]]; then
                printf '%s\n' 4242
            else
                : > "$restart_state"
                printf '%s\n' 0
            fi
        elif [[ "$1" == is-active ]]; then
            return 0
        else
            return 1
        fi
    }
    ods_sudo_available() { return 0; }
    ods_sudo() { [[ "$*" == "systemctl restart openclaw-gateway.service" ]]; }
    curl() { printf '%s\n' '{"ok":true,"status":"live"}'; }
    ods_pixel_run_as_owner() {
        [[ "$1" == "$owner" && "$2" == "$home" \
            && "$3" == "$restart_probe/pixel-root/pixel" && "$4" == verify ]]
    }
    _ods_pixel_restart_gateway_and_verify "$owner" "$home" "$restart_probe/pixel-root"
); then
    pass "privileged Pixel restart tolerates transient MainPID zero"
else
    fail "privileged Pixel restart tolerates transient MainPID zero"
fi

if (
    systemctl() {
        [[ "$1" == show ]] && printf '%s\n' 0
    }
    ods_sudo_available() { return 1; }
    _ods_pixel_restart_gateway_and_verify "$owner" "$home" "$restart_probe/pixel-root"
) >/dev/null 2>&1; then
    fail "unprivileged Pixel restart still rejects a missing owned process"
else
    pass "unprivileged Pixel restart still rejects a missing owned process"
fi

source_fixture="$TEST_ROOT/pixel-source-fixture"
mkdir -p "$source_fixture"
git -C "$source_fixture" init -q
printf '%s\n' fixture > "$source_fixture/pixel"
git -C "$source_fixture" add pixel
git -C "$source_fixture" -c user.name=test -c user.email=test@example.invalid commit -qm fixture
PIXEL_SOURCE_URL="$source_fixture"
PIXEL_SOURCE_REF="$(git -C "$source_fixture" rev-parse HEAD)"
source_checkout="$TEST_ROOT/pixel-checkouts/source-$PIXEL_SOURCE_REF"
check test "$(_ods_pixel_source_checkout "$owner" "$home" "$source_checkout")" = "$source_checkout"
check test "$(git -C "$source_checkout" rev-parse HEAD)" = "$PIXEL_SOURCE_REF"
check test -z "$(git -C "$source_checkout" status --porcelain)"

cat > "$mock_bin/git" <<'SH'
#!/usr/bin/env bash
sleep 10
SH
chmod +x "$mock_bin/git"
PIXEL_SOURCE_URL="https://github.com/Osmantic/Pixel.git"
PIXEL_SOURCE_REF="$(printf 'f%.0s' {1..40})"
timed_checkout="$TEST_ROOT/timed-checkouts/source-$PIXEL_SOURCE_REF"
if PATH="$mock_bin:$PATH" ODS_PIXEL_SOURCE_TIMEOUT_SECONDS=1 \
    _ods_pixel_source_checkout "$owner" "$home" "$timed_checkout" >/dev/null 2>&1; then
    fail "hung Pixel source clone is bounded and rejected"
elif [[ ! -e "$timed_checkout" ]] \
    && ! find "${timed_checkout%/*}" -mindepth 1 -print -quit | grep -q .; then
    pass "hung Pixel source clone is bounded and leaves no partial checkout"
else
    fail "failed Pixel source clone left a partial checkout"
fi

answers="$TEST_ROOT/onboarding.json"
export MAX_CONTEXT=32768
export LLM_MODEL=qwen-test
export LLAMA_REASONING=off
export OLLAMA_PORT=11434
export SEARXNG_PORT=8888
digest="$(printf 'a%.0s' {1..64})"
_ods_pixel_write_onboarding "$owner" "$home" "$answers" /usr/bin/openclaw /opt/ods/pixel-plugin "$digest"
observed_contract_sha256="$(_ods_pixel_contract_sha256 "$owner" "$home" "$answers")"
check test "$observed_contract_sha256" = "$(_ods_pixel_contract_sha256 "$owner" "$home" "$answers")"
check test "${#observed_contract_sha256}" = 64
check python3 -c '
import json,sys
v=json.load(open(sys.argv[1]))
assert v["capabilityProfile"] == "minimal"
assert v["modelBaseUrl"] == "http://127.0.0.1:11434/v1"
assert v["modelId"] == "qwen-test"
assert v["modelContextWindow"] == 32768
assert v["modelMaxTokens"] == 4096
assert v["modelReasoning"] is False
assert v["frontierBudgetProfile"] == "starter"
assert v["gatewayExtensions"] == [{"id":"pixel-ods","path":"/opt/ods/pixel-plugin","sha256":"a"*64,"tools":["pixel_ods_status","pixel_ods_apps_list","pixel_ods_web_extract"]}]
assert all(v[name] is False for name in ("emailLimbEnabled","calendarLimbEnabled","socialLimbEnabled","webLimbEnabled","operationsLimbEnabled","frontierLimbEnabled"))
' "$answers"
check test "$(stat -c '%a' "$answers")" = 600

MAX_CONTEXT=16384
LLM_MODEL=NVIDIA-Nemotron3-Nano-4B
_ods_pixel_write_onboarding "$owner" "$home" "$TEST_ROOT/nemotron-onboarding.json" \
    /usr/bin/openclaw /opt/ods/pixel-plugin "$digest"
check python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); assert v["modelContextWindow"] == 16384 and v["modelMaxTokens"] == 2048 and v["modelReasoning"] is False' \
    "$TEST_ROOT/nemotron-onboarding.json"
LLAMA_REASONING=on
LLM_MODEL=qwen-reasoning-enabled
_ods_pixel_write_onboarding "$owner" "$home" "$TEST_ROOT/qwen-reasoning-onboarding.json" \
    /usr/bin/openclaw /opt/ods/pixel-plugin "$digest"
check python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); assert v["modelReasoning"] is True' \
    "$TEST_ROOT/qwen-reasoning-onboarding.json"
LLAMA_REASONING=off
MAX_CONTEXT=8192
if _ods_pixel_write_onboarding "$owner" "$home" "$TEST_ROOT/undersized-onboarding.json" \
    /usr/bin/openclaw /opt/ods/pixel-plugin "$digest" >/dev/null 2>&1; then
    fail "Pixel onboarding below the usable 16K context floor rejected"
else
    pass "Pixel onboarding below the usable 16K context floor rejected"
fi
MAX_CONTEXT=32768
LLM_MODEL=qwen-test

runtime_home="$TEST_ROOT/runtime-home"
runtime_config="$runtime_home/.openclaw/openclaw.json"
runtime_validator="$TEST_ROOT/openclaw-validator"
mkdir -p "$runtime_home/.openclaw"
chmod 0700 "$runtime_home/.openclaw"
cat > "$runtime_config" <<'JSON'
{
  "agents": {
    "defaults": {"bootstrapMaxChars": 32000},
    "list": [{
      "id": "pixel",
      "model": "ods-local/qwen-test",
      "tools": {"deny": ["web_fetch", "web_search", "pixel_web_extract"]}
    }]
  },
  "models": {
    "providers": {
      "ods-local": {
        "api": "openai-completions",
        "apiKey": "local-no-auth",
        "baseUrl": "http://127.0.0.1:11434/v1",
        "models": [{
          "id": "qwen-test",
          "name": "ODS Local qwen-test",
          "contextWindow": 32768,
          "maxTokens": 4096
        }]
      }
    }
  },
  "plugins": {
    "entries": {
      "searxng": {
        "enabled": true,
        "config": {"webSearch": {"baseUrl": "http://127.0.0.1:8888"}}
      }
    }
  },
  "session": {"dmScope": "per-account-channel-peer"},
  "tools": {
    "profile": "coding",
    "alsoAllow": ["pixel_web_extract"],
    "sandbox": {"tools": {"allow": ["exec", "pixel_ods_status", "pixel_web_extract"]}},
    "web": {"search": {"provider": "searxng"}}
  }
}
JSON
chmod 0600 "$runtime_config"
cat > "$runtime_validator" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1 $2" == "config validate" ]]
python3 - "$OPENCLAW_CONFIG_PATH" <<'PY'
import json, pathlib, sys
value = json.load(open(sys.argv[1], encoding="utf-8"))
assert value["agents"]["defaults"]["timeoutSeconds"] == 1800
assert value["agents"]["defaults"]["bootstrapMaxChars"] == 32000
assert value["agents"]["defaults"]["bootstrapTotalMaxChars"] == 96000
assert value["agents"]["defaults"]["contextInjection"] == "continuation-skip"
assert value["models"]["providers"]["ods-local"]["timeoutSeconds"] == 1800
agent = value["agents"]["list"][0]
model = value["models"]["providers"]["ods-local"]["models"][0]
assert agent["tools"]["deny"] == []
assert {"pixel_ods_status", "pixel_ods_apps_list", "pixel_ods_web_extract"}.issubset(value["tools"]["alsoAllow"])
assert {"web_search", "web_fetch", "pixel_ods_status", "pixel_ods_apps_list", "pixel_ods_web_extract"}.issubset(value["tools"]["sandbox"]["tools"]["allow"])
assert "pixel_web_extract" not in value["tools"]["alsoAllow"]
assert "pixel_web_extract" not in value["tools"]["sandbox"]["tools"]["allow"]
assert value["tools"]["web"]["fetch"] == {
    "enabled": True,
    "maxChars": 12000,
    "maxCharsCap": 20000,
    "maxResponseBytes": 1000000,
    "timeoutSeconds": 20,
    "cacheTtlMinutes": 15,
    "maxRedirects": 3,
    "readability": True,
    "useTrustedEnvProxy": False,
    "ssrfPolicy": {
        "allowRfc2544BenchmarkRange": False,
        "allowIpv6UniqueLocalRange": False,
    },
}
assert value["tools"]["loopDetection"] == {
    "enabled": True,
    "historySize": 12,
    "warningThreshold": 2,
    "unknownToolThreshold": 2,
    "criticalThreshold": 4,
    "globalCircuitBreakerThreshold": 6,
    "detectors": {
        "genericRepeat": True,
        "knownPollNoProgress": True,
        "pingPong": True,
    },
}
assert value["agents"]["defaults"]["compaction"] == {
    "reserveTokens": model["maxTokens"], "reserveTokensFloor": 0,
}
if "qwen" in model["id"].lower() and model["reasoning"] is True:
    assert agent["thinkingDefault"] == "low"
    assert model["compat"] == {"thinkingFormat": "qwen-chat-template"}
else:
    assert "thinkingDefault" not in agent
    assert model["reasoning"] is False
    assert "compat" not in model
assert value["diagnostics"]["stuckSessionAbortMs"] == 1860000
assert value["session"]["writeLock"] == {"maxHoldMs": 1920000, "staleMs": 3600000}
assert value["agents"]["defaults"]["sandbox"]["docker"]["binds"] == [
    "{}:/run/pixel-ods-control:ro".format(
        pathlib.Path.home() / ".openclaw" / ".ods-exec-control"
    )
]
assert value["agents"]["defaults"]["sandbox"]["docker"]["dangerouslyAllowExternalBindSources"] is True
PY
SH
chmod 0755 "$runtime_validator"
runtime_recovery_candidate="$runtime_home/.openclaw/recovery-candidate.json"
cp "$runtime_config" "$runtime_recovery_candidate"
chmod 0600 "$runtime_recovery_candidate"
check test "$(_ods_pixel_apply_runtime_budget "$owner" "$runtime_home" "$runtime_config" "$runtime_validator")" = changed
runtime_sha256="$(sha256sum "$runtime_config" | awk '{print $1}')"
check python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); d=v["agents"]["defaults"]; assert d["timeoutSeconds"] == 1800 and d["bootstrapMaxChars"] == 32000 and d["bootstrapTotalMaxChars"] == 96000 and d["contextInjection"] == "continuation-skip"; assert d["compaction"] == {"reserveTokens":4096,"reserveTokensFloor":0}; assert d["sandbox"]["docker"]["binds"] == [sys.argv[2] + "/.openclaw/.ods-exec-control:/run/pixel-ods-control:ro"] and d["sandbox"]["docker"]["dangerouslyAllowExternalBindSources"] is True; a=v["agents"]["list"][0]; assert "thinkingDefault" not in a and a["tools"]["deny"] == []; assert v["models"]["providers"]["ods-local"]["timeoutSeconds"] == 1800; m=v["models"]["providers"]["ods-local"]["models"][0]; assert m["reasoning"] is False and "compat" not in m; assert v["diagnostics"]["stuckSessionAbortMs"] == 1860000; assert v["session"]["writeLock"] == {"maxHoldMs":1920000,"staleMs":3600000}; assert {"pixel_ods_status","pixel_ods_apps_list","pixel_ods_web_extract"}.issubset(v["tools"]["alsoAllow"]); assert {"web_search","web_fetch","pixel_ods_status","pixel_ods_apps_list","pixel_ods_web_extract"}.issubset(v["tools"]["sandbox"]["tools"]["allow"]) and v["tools"]["loopDetection"]["globalCircuitBreakerThreshold"] == 6; assert v["tools"]["web"]["fetch"]["enabled"] is True and v["tools"]["web"]["fetch"]["maxChars"] == 12000 and v["tools"]["web"]["fetch"]["timeoutSeconds"] == 20 and v["tools"]["web"]["fetch"]["ssrfPolicy"] == {"allowRfc2544BenchmarkRange":False,"allowIpv6UniqueLocalRange":False}' "$runtime_config" "$runtime_home"
check test "$(_ods_pixel_apply_runtime_budget "$owner" "$runtime_home" "$runtime_config" "$runtime_validator")" = unchanged
check test "$(sha256sum "$runtime_config" | awk '{print $1}')" = "$runtime_sha256"
check test "$(_ods_pixel_apply_runtime_budget "$owner" "$runtime_home" "$runtime_recovery_candidate" "$runtime_validator")" = changed
check _ods_pixel_candidate_config_matches_live "$owner" "$runtime_home" "$runtime_recovery_candidate"
check test -z "$(find "$runtime_home/.openclaw" -maxdepth 1 -name '.ods-pixel-runtime-budget.*' -print -quit)"

runtime_unsafe_bind="$runtime_home/.openclaw/unsafe-bind.json"
python3 - "$runtime_config" "$runtime_unsafe_bind" <<'PY'
import json, pathlib, sys
source, target = map(pathlib.Path, sys.argv[1:])
value = json.loads(source.read_text())
value["agents"]["defaults"]["sandbox"]["docker"]["binds"] = [
    "/:/host:rw"
]
target.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
PY
chmod 0600 "$runtime_unsafe_bind"
if _ods_pixel_apply_runtime_budget "$owner" "$runtime_home" "$runtime_unsafe_bind" \
    "$runtime_validator" >/dev/null 2>&1; then
    fail "unmanaged Pixel sandbox bind rejected"
else
    pass "unmanaged Pixel sandbox bind rejected"
fi

runtime_target="$TEST_ROOT/runtime-target.json"
runtime_link="$TEST_ROOT/runtime-link.json"
cp "$runtime_config" "$runtime_target"
ln -s "$runtime_target" "$runtime_link"
if _ods_pixel_apply_runtime_budget "$owner" "$runtime_home" "$runtime_link" "$runtime_validator" >/dev/null 2>&1; then
    fail "symlink ODS Pixel runtime config rejected"
else
    pass "symlink ODS Pixel runtime config rejected"
fi
chmod 0644 "$runtime_config"
if _ods_pixel_apply_runtime_budget "$owner" "$runtime_home" "$runtime_config" "$runtime_validator" >/dev/null 2>&1; then
    fail "unsafe ODS Pixel runtime config mode rejected"
else
    pass "unsafe ODS Pixel runtime config mode rejected"
fi
chmod 0600 "$runtime_config"

runtime_unvalidated="$runtime_home/.openclaw/unvalidated.json"
python3 - "$runtime_config" "$runtime_unvalidated" <<'PY'
import json, pathlib, sys
source, target = map(pathlib.Path, sys.argv[1:])
value = json.loads(source.read_text())
value["agents"]["defaults"].pop("timeoutSeconds")
value["models"]["providers"]["ods-local"].pop("timeoutSeconds")
value.pop("diagnostics")
value["session"].pop("writeLock")
target.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
PY
chmod 0600 "$runtime_unvalidated"
runtime_unvalidated_sha256="$(sha256sum "$runtime_unvalidated" | awk '{print $1}')"
if _ods_pixel_apply_runtime_budget "$owner" "$runtime_home" "$runtime_unvalidated" /bin/false >/dev/null 2>&1; then
    fail "invalid OpenClaw runtime budget candidate rejected"
else
    pass "invalid OpenClaw runtime budget candidate rejected"
fi
check test "$(sha256sum "$runtime_unvalidated" | awk '{print $1}')" = "$runtime_unvalidated_sha256"
check test -z "$(find "$runtime_home/.openclaw" -maxdepth 1 -name '.ods-pixel-runtime-budget.*' -print -quit)"

reconcile_home="$TEST_ROOT/reconcile-home"
reconcile_answers="$TEST_ROOT/reconcile-onboarding.json"
reconcile_candidate="$TEST_ROOT/reconcile-candidate.json"
reconcile_marker="$reconcile_home/.config/ods/pixel-managed.json"
reconcile_config="$reconcile_home/.openclaw/openclaw.json"
reconcile_ref="$(printf '9%.0s' {1..40})"
mkdir -p "$reconcile_home/.config/ods" "$reconcile_home/.openclaw/backups" \
    "$reconcile_home/.local/share/pixel"
chmod 0700 "$reconcile_home/.openclaw" "$reconcile_home/.openclaw/backups"
chmod 0700 "$reconcile_home/.config/ods"
cp "$answers" "$reconcile_answers"
python3 - "$reconcile_answers" "$reconcile_config" "$reconcile_candidate" <<'PY'
import copy, json, pathlib, sys

answers_path, live_path, candidate_path = map(pathlib.Path, sys.argv[1:])
answers = json.loads(answers_path.read_text())
answers["modelId"] = "qwen-old"
answers["modelName"] = "ODS Local qwen-old"
answers_path.write_text(json.dumps(answers, indent=2, sort_keys=True) + "\n")
base = {
    "agents": {
        "defaults": {"bootstrapMaxChars": 32000},
        "list": [{
            "id": "pixel",
            "model": "ods-local/qwen-old",
            "preserve": 7,
            "tools": {"deny": ["web_fetch", "web_search"]},
        }],
    },
    "gateway": {"bind": "loopback"},
    "models": {"providers": {"ods-local": {
        "api": "openai-completions",
        "apiKey": "local-no-auth",
        "baseUrl": "http://127.0.0.1:11434/v1",
        "models": [{
            "id": "qwen-old",
            "name": "ODS Local qwen-old",
            "contextWindow": answers["modelContextWindow"],
            "maxTokens": answers["modelMaxTokens"],
            "reasoning": answers["modelReasoning"],
            "input": ["text"],
        }],
    }}},
    "plugins": {"entries": {"searxng": {
        "enabled": True,
        "config": {"webSearch": {"baseUrl": "http://127.0.0.1:8888"}},
    }}},
    "session": {"dmScope": "per-account-channel-peer"},
    "tools": {
        "profile": "coding",
        "sandbox": {"tools": {"allow": ["exec", "pixel_ods_status"]}},
        "web": {"search": {"provider": "searxng"}},
    },
}
candidate = copy.deepcopy(base)
candidate["agents"]["list"][0]["model"] = "ods-local/qwen-new"
candidate_model = candidate["models"]["providers"]["ods-local"]["models"][0]
candidate_model["id"] = "qwen-new"
candidate_model["name"] = "ODS Local qwen-new"
candidate_model["contextWindow"] = 65536
candidate_model["maxTokens"] = 2048
candidate_model["reasoning"] = True
live_path.write_text(json.dumps(base, indent=2, sort_keys=True) + "\n")
candidate_path.write_text(json.dumps(candidate, indent=2, sort_keys=True) + "\n")
PY
chmod 0600 "$reconcile_answers" "$reconcile_config" "$reconcile_candidate"
check test "$(_ods_pixel_apply_runtime_budget "$owner" "$reconcile_home" "$reconcile_config" "$runtime_validator")" = changed
python3 - "$reconcile_config" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
value = json.loads(path.read_text())
agent = value["agents"]["list"][0]
model = value["models"]["providers"]["ods-local"]["models"][0]
agent.pop("thinkingDefault", None)
model.pop("compat", None)
model["reasoning"] = False
path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
PY
printf '%s\n' '{"kind":"pixel-runtime-attestation"}' > "$reconcile_home/.local/share/pixel/runtime-attestation.json"
chmod 0600 "$reconcile_home/.local/share/pixel/runtime-attestation.json"
python3 - "$reconcile_marker" "$reconcile_config" "$INSTALL_DIR" "$reconcile_ref" <<'PY'
import hashlib, json, pathlib, sys

marker, config, install_dir, source_ref = sys.argv[1:]
value = json.loads(pathlib.Path(config).read_text())
canonical = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
payload = {
    "schema_version": 2,
    "manager": "ods",
    "state": "ready",
    "initial_active_state": "absent",
    "install_dir": install_dir,
    "pixel_source_ref": source_ref,
    "contract_sha256": "a" * 64,
    "configuration_sha256": hashlib.sha256(b"ods-pixel-openclaw-v1\0" + canonical).hexdigest(),
    "active_release_version": "4.3.14",
    "release_identity_sha256": "b" * 64,
    "install_manifest_sha256": "c" * 64,
    "sandbox_image": "openclaw-sandbox:test",
    "sandbox_image_id": "sha256:" + "d" * 64,
}
pathlib.Path(marker).write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
PY
chmod 0600 "$reconcile_marker"
check test "$(_ods_pixel_managed_source_ref "$owner" "$reconcile_home")" = "$reconcile_ref"
reconcile_backup="$(_ods_pixel_model_reconciliation_snapshot "$owner" "$reconcile_home" "$reconcile_answers")"
check python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); assert v["modelId"] == "qwen-old" and v["modelName"] == "ODS Local qwen-old"' "$reconcile_backup/rollback-onboarding.json"
_ods_pixel_update_onboarding_model "$owner" "$reconcile_home" "$reconcile_answers" \
    qwen-new 65536 2048 true
check python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); assert v["modelId"] == "qwen-new" and v["modelName"] == "ODS Local qwen-new" and v["modelContextWindow"] == 65536 and v["modelMaxTokens"] == 2048 and v["modelReasoning"] is True' "$reconcile_answers"
if _ods_pixel_update_onboarding_model "$owner" "$reconcile_home" "$reconcile_answers" \
    qwen-invalid 2048 1024 false >/dev/null 2>&1; then
    fail "undersized Pixel model context rejected"
else
    pass "undersized Pixel model context rejected"
fi
check test "$(_ods_pixel_apply_runtime_budget "$owner" "$reconcile_home" "$reconcile_candidate" "$runtime_validator")" = changed
check python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); a=v["agents"]["list"][0]; m=v["models"]["providers"]["ods-local"]["models"][0]; assert m["reasoning"] is True and m["compat"] == {"thinkingFormat":"qwen-chat-template"} and a["thinkingDefault"] == "low"' "$reconcile_candidate"
check _ods_pixel_candidate_is_managed_runtime_update "$owner" "$reconcile_home" "$reconcile_candidate" "$reconcile_answers"
cp "$reconcile_config" "$TEST_ROOT/reconcile-config-with-control-bind.json"
python3 - "$reconcile_config" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
value = json.loads(path.read_text())
value["agents"]["defaults"].pop("sandbox", None)
path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
PY
chmod 0600 "$reconcile_config"
check _ods_pixel_candidate_is_managed_runtime_update "$owner" "$reconcile_home" "$reconcile_candidate" "$reconcile_answers"
cp "$TEST_ROOT/reconcile-config-with-control-bind.json" "$reconcile_config"
chmod 0600 "$reconcile_config"
python3 - "$reconcile_candidate" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
value = json.loads(path.read_text())
value["gateway"]["bind"] = "lan"
path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
PY
if _ods_pixel_candidate_is_managed_runtime_update "$owner" "$reconcile_home" "$reconcile_candidate" "$reconcile_answers" >/dev/null 2>&1; then
    fail "unmanaged Pixel candidate change rejected"
else
    pass "unmanaged Pixel candidate change rejected"
fi
python3 - "$reconcile_candidate" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
value = json.loads(path.read_text())
value["gateway"]["bind"] = "loopback"
path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
PY
chmod 0600 "$reconcile_candidate"
check _ods_pixel_atomic_replace_managed_file "$owner" "$reconcile_home" "$reconcile_candidate" "$reconcile_config"
check _ods_pixel_candidate_config_matches_live "$owner" "$reconcile_home" "$reconcile_candidate"
linked_reconcile_candidate="$TEST_ROOT/reconcile-candidate-link.json"
ln -s "$reconcile_candidate" "$linked_reconcile_candidate"
if _ods_pixel_atomic_replace_managed_file "$owner" "$reconcile_home" "$linked_reconcile_candidate" "$reconcile_config" >/dev/null 2>&1; then
    fail "symlink model reconciliation source rejected"
else
    pass "symlink model reconciliation source rejected"
fi

# A model-family change is part of the supported ODS swap contract, not only a
# Qwen-to-Qwen rename. The exact model limits may change and Qwen-only runtime
# policy must disappear, while every unrelated Pixel field stays identical.
non_qwen_answers="$TEST_ROOT/non-qwen-onboarding.json"
non_qwen_candidate="$TEST_ROOT/non-qwen-candidate.json"
cp "$reconcile_answers" "$non_qwen_answers"
cp "$reconcile_config" "$non_qwen_candidate"
_ods_pixel_update_onboarding_model "$owner" "$reconcile_home" "$non_qwen_answers" \
    phi-4-mini 128000 4096 false
python3 - "$non_qwen_candidate" <<'PY'
import json, pathlib, sys

path = pathlib.Path(sys.argv[1])
value = json.loads(path.read_text())
agent = next(item for item in value["agents"]["list"] if item.get("id") == "pixel")
model = value["models"]["providers"]["ods-local"]["models"][0]
agent["model"] = "ods-local/phi-4-mini"
agent.pop("thinkingDefault", None)
model.update({
    "id": "phi-4-mini",
    "name": "ODS Local phi-4-mini",
    "contextWindow": 128000,
    "maxTokens": 4096,
    "reasoning": False,
})
model.pop("compat", None)
path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
PY
chmod 0600 "$non_qwen_answers" "$non_qwen_candidate"
check test "$(_ods_pixel_apply_runtime_budget "$owner" "$reconcile_home" "$non_qwen_candidate" "$runtime_validator")" = changed
check _ods_pixel_candidate_is_managed_runtime_update "$owner" "$reconcile_home" \
    "$non_qwen_candidate" "$non_qwen_answers"
check _ods_pixel_atomic_replace_managed_file "$owner" "$reconcile_home" \
    "$non_qwen_candidate" "$reconcile_config"
check python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); a=v["agents"]["list"][0]; m=v["models"]["providers"]["ods-local"]["models"][0]; assert m["id"] == "phi-4-mini" and m["contextWindow"] == 128000 and m["maxTokens"] == 4096 and m["reasoning"] is False and "compat" not in m and "thinkingDefault" not in a' "$reconcile_config"

linked_answers="$TEST_ROOT/onboarding-linked.json"
printf '%s\n' 'sentinel' > "$TEST_ROOT/onboarding-link-target"
ln -s "$TEST_ROOT/onboarding-link-target" "$linked_answers"
if _ods_pixel_write_onboarding "$owner" "$home" "$linked_answers" /usr/bin/openclaw /opt/ods/pixel-plugin "$digest" >/dev/null 2>&1; then
    fail "symlink Pixel onboarding contract rejected"
else
    pass "symlink Pixel onboarding contract rejected"
fi
check test "$(cat "$TEST_ROOT/onboarding-link-target")" = sentinel

original_run_as_owner="$(declare -f ods_pixel_run_as_owner)"
mock_ingress_attempts="$TEST_ROOT/ingress-attempts"
ods_pixel_run_as_owner() {
    local count=0
    [[ -f "$mock_ingress_attempts" ]] && read -r count < "$mock_ingress_attempts"
    count=$((count + 1))
    printf '%s\n' "$count" > "$mock_ingress_attempts"
    (( count >= 3 )) || return 7
    printf '%s\n' '{"status":"ok"}'
}
check _ods_pixel_wait_ingress "$owner" "$home" 3 0
check test "$(cat "$mock_ingress_attempts")" = 3
ods_pixel_run_as_owner() { printf '%s\n' '{"status":"starting"}'; }
if _ods_pixel_wait_ingress "$owner" "$home" 2 0; then
    fail "non-ready Pixel ingress status rejected"
else
    pass "non-ready Pixel ingress status rejected"
fi
eval "$original_run_as_owner"

# The long-lived host agent normally lacks an active sudo credential. Prove
# its fallback can only terminate the same-owner PID of the exact hardened
# Restart=always unit, then waits for systemd to replace it before verification.
gateway_mock_root="$TEST_ROOT/gateway-restart-mock"
mkdir -p "$gateway_mock_root"
printf '0\n' > "$gateway_mock_root/mainpid-calls"
systemctl() {
    case "$*" in
        'show openclaw-gateway.service -p MainPID --value')
            local count
            read -r count < "$gateway_mock_root/mainpid-calls"
            count=$((count + 1))
            printf '%s\n' "$count" > "$gateway_mock_root/mainpid-calls"
            if (( count <= 2 )); then printf '111\n'; else printf '222\n'; fi
            ;;
        'show openclaw-gateway.service -p User --value') printf '%s\n' "$owner" ;;
        'show openclaw-gateway.service -p Restart --value') printf 'always\n' ;;
        'is-active --quiet openclaw-gateway.service') return 0 ;;
        *) return 1 ;;
    esac
}
id() {
    case "$1" in
        -u) printf '1000\n' ;;
        -un) printf '%s\n' "$owner" ;;
        *) return 1 ;;
    esac
}
awk() {
    [[ "$*" == *'/proc/111/status'* ]] || return 1
    printf '1000\n'
}
kill() {
    printf '%s\n' "$*" >> "$gateway_mock_root/kills"
}
curl() {
    printf '%s\n' '{"ok":true,"status":"live"}'
}
jq() {
    command jq "$@"
}
sleep() { :; }
ods_sudo_available() { return 1; }
ods_pixel_run_as_owner() {
    printf '%s\n' "$*" >> "$gateway_mock_root/owner-runs"
}
check _ods_pixel_restart_gateway_and_verify "$owner" "$reconcile_home" /verified/pixel
check test "$(cat "$gateway_mock_root/kills")" = '-TERM 111'
check grep -F '/verified/pixel/pixel verify' "$gateway_mock_root/owner-runs"

# A mismatched systemd User must fail before any signal is sent.
printf '0\n' > "$gateway_mock_root/mainpid-calls"
: > "$gateway_mock_root/kills"
systemctl() {
    case "$*" in
        'show openclaw-gateway.service -p MainPID --value') printf '111\n' ;;
        'show openclaw-gateway.service -p User --value') printf 'someone-else\n' ;;
        'show openclaw-gateway.service -p Restart --value') printf 'always\n' ;;
        *) return 1 ;;
    esac
}
if _ods_pixel_restart_gateway_and_verify "$owner" "$reconcile_home" /verified/pixel >/dev/null 2>&1; then
    fail "mismatched Pixel gateway unit owner rejected"
else
    pass "mismatched Pixel gateway unit owner rejected"
fi
check test ! -s "$gateway_mock_root/kills"
unset -f systemctl id awk kill curl jq sleep ods_sudo_available
eval "$original_run_as_owner"

plugin="$ROOT/extensions/services/pixel-agent/plugin"
check node --check "$plugin/index.js"
check node --check "$plugin/projection.mjs"
check node --check "$plugin/prompt-contract.mjs"
check node --check "$plugin/tool-content.mjs"
check node --check "$plugin/tool-loop-guard.mjs"
check node --check "$plugin/web-extract.mjs"
check sh -n "$ROOT/extensions/services/pixel-agent/host/cancellable-exec.sh"
check python3 -c '
import json,sys
p=json.load(open(sys.argv[1])); m=json.load(open(sys.argv[2]))
assert p["type"] == "module" and p["openclaw"]["extensions"] == ["./index.js"]
assert "dependencies" not in p
assert sorted(m["contracts"]["tools"]) == ["pixel_ods_apps_list","pixel_ods_status","pixel_ods_web_extract"]
import re
reserved = re.compile(r"^pixel_(?:gmail|calendar|social|web|ops|frontier)_")
assert all(name != "pixel_limb_status" and not reserved.match(name) for name in m["contracts"]["tools"])
assert "toolMetadata" not in m
' "$plugin/package.json" "$plugin/openclaw.plugin.json"
check python3 -c '
import pathlib,sys
text=pathlib.Path(sys.argv[1]).read_text()
assert "api.on(\"before_prompt_build\"" in text
assert "promptContractForAgent(context, AGENT_ID, event)" in text
' "$plugin/index.js"
# Dollar expressions below are literal source-code assertions.
# shellcheck disable=SC2016
check python3 -c '
import pathlib,sys
text=pathlib.Path(sys.argv[1]).read_text()
installer=text[text.index("ods_pixel_install_default_agent() {"):]
assert "ods_pixel_run_as_owner \"$owner\" \"$home\" curl" in text
assert "_ods_pixel_wait_ingress \"$owner\" \"$home\"" in installer
assert installer.index("_ods_pixel_wait_ingress \"$owner\" \"$home\"") < installer.index("_ods_pixel_mark_ready \"$owner\" \"$home\"")
assert "pixel\" configure --answers \"$answers\" --force" in text
assert "pixel\" plan" in text
assert "pixel\" apply --confirm &&" in text
assert "_ods_pixel_managed_contract_matches" in text
assert "_ods_pixel_verified_source_matches" in text
assert "_ods_pixel_candidate_config_matches_live" in text
assert "_ods_pixel_apply_runtime_budget" in text
assert "_ods_pixel_install_exec_control" in text
assert "_ods_pixel_recreate_agent_sandbox" in text
assert "_ods_pixel_refresh_plugin_registry" in text
assert "plugins registry --refresh --json" in text
assert "ods_pixel_reconcile_promoted_model" in text
assert "failure_phase=\"onboarding-update\"" in text
assert "failure_phase=\"pixel-configure\"" in text
assert "failure_phase=\"pixel-plan\"" in text
assert "failure_phase=\"runtime-budget\"" in text
assert "failure_phase=\"managed-update-validation\"" in text
assert "failure_phase=\"config-install\"" in text
assert "failure_phase=\"gateway-restart-verify\"" in text
assert "failure_phase=\"sandbox-recreate\"" in text
assert "failure_phase=\"contract-hash\"" in text
assert "failure_phase=\"ready-marker\"" in text
assert "failure_phase=\"installing-marker\"" in text
assert "rollback=verified" in text
assert "rollback=failed" in text
assert installer.index("if _ods_pixel_verified_source_matches") < installer.index("_ods_pixel_mark_installing")
assert "The exact ODS-managed Pixel contract is already active" in text
assert "refreshing the verified ODS extension without reapplying the release" in text
assert "repairing the interrupted ownership checkpoint" in text
candidate_recovery = installer.index("Could not validate the exact-source Pixel runtime candidate")
model_reconcile = installer.index("ods_pixel_reconcile_promoted_model", candidate_recovery)
assert installer.index("_ods_pixel_apply_runtime_budget", candidate_recovery - 1000) < candidate_recovery < model_reconcile
assert "pixel\" verify >>\"$LOG_FILE\"" in text
assert "if ! _ods_pixel_install_ingress" in text
assert "systemctl restart pixel-ingress.service" in text
assert "if ! _ods_pixel_mark_verified_installing" in text
assert text.index("_ods_pixel_mark_verified_installing \"$owner\"") < text.index("_ods_pixel_install_ingress \"$owner\"")
assert "if ! _ods_pixel_mark_ready" in text
runtime_overlay = installer.index("runtime_budget_status=\"")
runtime_checkpoint = installer.index(
    "Could not bind the verified Pixel ODS local-runtime configuration.",
    runtime_overlay,
)
registry_refresh = installer.index("_ods_pixel_refresh_plugin_registry", runtime_overlay)
assert runtime_overlay < runtime_checkpoint < registry_refresh
assert installer.index("_ods_pixel_refresh_plugin_registry") < installer.index("_ods_pixel_mark_ready")
assert "ods_linux_node_tools_available" in text
assert "runtime_token_file=\"/run/ods-pixel/openclaw.json\"" in text
assert "PIXEL_GATEWAY_TOKEN_FILE=$runtime_token_file" in text
assert "PIXEL_ODS_VERSION=$ods_version" in text
' "$ROOT/installers/lib/pixel-host-install.sh"
check python3 -c '
import pathlib,sys
phase=pathlib.Path(sys.argv[1]).read_text()
handoff = (
    "ods_pixel_activate_source_contract \\\n"
    "            \"$PIXEL_SOURCE_URL_VALUE\" \"$PIXEL_SOURCE_REF_VALUE\" \"$PIXEL_SOURCE_DIR_VALUE\""
)
assert handoff in phase
assert phase.index(handoff) < phase.index("PIXEL_SOURCE_URL=$(dotenv_quote")
assert "PIXEL_SOURCE_REF \"f1f811d02bffd5a1589eb6feb34323f6dadf7832\"" in phase
' "$ROOT/installers/phases/06-directories.sh"
check python3 -c '
import pathlib,sys
text=pathlib.Path(sys.argv[1]).read_text()
assert "ProtectHome=true" in text
assert "RestrictNamespaces=true" in text
assert "RuntimeDirectoryPreserve=restart" in text
assert "BindReadOnlyPaths=__PIXEL_GATEWAY_TOKEN_SOURCE__:__PIXEL_GATEWAY_TOKEN_FILE__" in text
' "$ROOT/extensions/services/pixel-agent/host/pixel-ingress.service"
check python3 -c '
import pathlib,sys
text=pathlib.Path(sys.argv[1]).read_text()
reconcile=text.index("if ! reconcile_ods_managed_pixel_model")
discard=text.index("discard_active_model_config_snapshot", reconcile)
cleanup=text.index("# ── Phase 5b: Remove bootstrap model", reconcile)
assert reconcile < discard < cleanup
' "$ROOT/scripts/bootstrap-upgrade.sh"

printf '\nResults: %d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
