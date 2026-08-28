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
assert v["frontierBudgetProfile"] == "starter"
assert v["gatewayExtensions"] == [{"id":"pixel-ods","path":"/opt/ods/pixel-plugin","sha256":"a"*64,"tools":["pixel_ods_status","pixel_ods_apps_list"]}]
assert all(v[name] is False for name in ("emailLimbEnabled","calendarLimbEnabled","socialLimbEnabled","webLimbEnabled","operationsLimbEnabled","frontierLimbEnabled"))
' "$answers"
check test "$(stat -c '%a' "$answers")" = 600

runtime_home="$TEST_ROOT/runtime-home"
runtime_config="$runtime_home/.openclaw/openclaw.json"
runtime_validator="$TEST_ROOT/openclaw-validator"
mkdir -p "$runtime_home/.openclaw"
chmod 0700 "$runtime_home/.openclaw"
cat > "$runtime_config" <<'JSON'
{
  "agents": {
    "defaults": {"bootstrapMaxChars": 32000},
    "list": [{"id": "pixel", "model": "ods-local/qwen-test"}]
  },
  "models": {
    "providers": {
      "ods-local": {
        "api": "openai-completions",
        "apiKey": "local-no-auth",
        "baseUrl": "http://127.0.0.1:11434/v1",
        "models": [{"id": "qwen-test", "name": "ODS Local qwen-test"}]
      }
    }
  },
  "session": {"dmScope": "per-account-channel-peer"}
}
JSON
chmod 0600 "$runtime_config"
cat > "$runtime_validator" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1 $2" == "config validate" ]]
python3 - "$OPENCLAW_CONFIG_PATH" <<'PY'
import json, sys
value = json.load(open(sys.argv[1], encoding="utf-8"))
assert value["agents"]["defaults"]["timeoutSeconds"] == 1800
assert value["models"]["providers"]["ods-local"]["timeoutSeconds"] == 1800
assert value["session"]["writeLock"] == {"maxHoldMs": 1920000, "staleMs": 3600000}
PY
SH
chmod 0755 "$runtime_validator"
check test "$(_ods_pixel_apply_runtime_budget "$owner" "$runtime_home" "$runtime_config" "$runtime_validator")" = changed
runtime_sha256="$(sha256sum "$runtime_config" | awk '{print $1}')"
check python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); assert v["agents"]["defaults"]["timeoutSeconds"] == 1800; assert v["models"]["providers"]["ods-local"]["timeoutSeconds"] == 1800; assert v["session"]["writeLock"] == {"maxHoldMs":1920000,"staleMs":3600000}' "$runtime_config"
check test "$(_ods_pixel_apply_runtime_budget "$owner" "$runtime_home" "$runtime_config" "$runtime_validator")" = unchanged
check test "$(sha256sum "$runtime_config" | awk '{print $1}')" = "$runtime_sha256"
check test -z "$(find "$runtime_home/.openclaw" -maxdepth 1 -name '.ods-pixel-runtime-budget.*' -print -quit)"

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
        "list": [{"id": "pixel", "model": "ods-local/qwen-old", "preserve": 7}],
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
    "session": {"dmScope": "per-account-channel-peer"},
}
candidate = copy.deepcopy(base)
candidate["agents"]["list"][0]["model"] = "ods-local/qwen-new"
candidate_model = candidate["models"]["providers"]["ods-local"]["models"][0]
candidate_model["id"] = "qwen-new"
candidate_model["name"] = "ODS Local qwen-new"
live_path.write_text(json.dumps(base, indent=2, sort_keys=True) + "\n")
candidate_path.write_text(json.dumps(candidate, indent=2, sort_keys=True) + "\n")
PY
chmod 0600 "$reconcile_answers" "$reconcile_config" "$reconcile_candidate"
check test "$(_ods_pixel_apply_runtime_budget "$owner" "$reconcile_home" "$reconcile_config" "$runtime_validator")" = changed
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
_ods_pixel_update_onboarding_model "$owner" "$reconcile_home" "$reconcile_answers" qwen-new
check python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); assert v["modelId"] == "qwen-new" and v["modelName"] == "ODS Local qwen-new"' "$reconcile_answers"
check test "$(_ods_pixel_apply_runtime_budget "$owner" "$reconcile_home" "$reconcile_candidate" "$runtime_validator")" = changed
check _ods_pixel_candidate_is_model_only_update "$owner" "$reconcile_home" "$reconcile_candidate" "$reconcile_answers"
python3 - "$reconcile_candidate" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
value = json.loads(path.read_text())
value["gateway"]["bind"] = "lan"
path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
PY
if _ods_pixel_candidate_is_model_only_update "$owner" "$reconcile_home" "$reconcile_candidate" "$reconcile_answers" >/dev/null 2>&1; then
    fail "non-model Pixel candidate change rejected"
else
    pass "non-model Pixel candidate change rejected"
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
assert "ods_pixel_reconcile_promoted_model" in text
assert installer.index("if _ods_pixel_verified_source_matches") < installer.index("_ods_pixel_mark_installing")
assert "The exact ODS-managed Pixel contract is already active" in text
assert "refreshing the verified ODS extension without reapplying the release" in text
assert "pixel\" verify >>\"$LOG_FILE\"" in text
assert "if ! _ods_pixel_install_ingress" in text
assert "if ! _ods_pixel_mark_verified_installing" in text
assert text.index("_ods_pixel_mark_verified_installing \"$owner\"") < text.index("_ods_pixel_install_ingress \"$owner\"")
assert "if ! _ods_pixel_mark_ready" in text
assert "ods_linux_node_tools_available" in text
assert "runtime_token_file=\"/run/ods-pixel/openclaw.json\"" in text
assert "PIXEL_GATEWAY_TOKEN_FILE=$runtime_token_file" in text
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
' "$ROOT/installers/phases/06-directories.sh"
check python3 -c '
import pathlib,sys
text=pathlib.Path(sys.argv[1]).read_text()
assert "ProtectHome=true" in text
assert "RestrictNamespaces=true" in text
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
