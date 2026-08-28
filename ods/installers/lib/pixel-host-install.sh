#!/usr/bin/env bash
# Install and verify Pixel's host-side ODS integration. Importing this file has
# no side effects. Callers must have already selected ENABLE_PIXEL_RUNTIME=true.

ods_pixel_install_owner() {
    local owner="${INSTALL_USER:-${SUDO_USER:-${USER:-}}}"
    [[ -n "$owner" && "$owner" != root && "$owner" =~ ^[A-Za-z_][A-Za-z0-9_.-]{0,63}$ ]] || {
        printf '%s\n' 'error: Pixel requires a non-root ODS install owner' >&2
        return 1
    }
    id "$owner" >/dev/null 2>&1 || return 1
    printf '%s\n' "$owner"
}

ods_pixel_owner_home() {
    local owner="$1" home
    home="$(getent passwd "$owner" 2>/dev/null | awk -F: 'NR == 1 { print $6 }')"
    [[ "$home" == /* && "$home" != / && "$home" != *[[:space:]\\]* && -d "$home" && ! -L "$home" ]] || return 1
    printf '%s\n' "$home"
}

ods_pixel_run_as_owner() {
    local owner="$1" home="$2"
    shift 2
    if ods_sudo_available && command -v sudo >/dev/null 2>&1; then
        ods_sudo -u "$owner" -- env HOME="$home" USER="$owner" LOGNAME="$owner" PATH="$PATH" "$@"
    elif [[ "$(id -un)" == "$owner" ]]; then
        env HOME="$home" USER="$owner" LOGNAME="$owner" PATH="$PATH" "$@"
    else
        printf '%s\n' 'error: cannot enter the Pixel install owner identity' >&2
        return 1
    fi
}

_ods_pixel_assert_managed_state() {
    local owner="$1" home="$2" marker
    marker="$home/.config/ods/pixel-managed.json"
    local gateway_unit="${ODS_PIXEL_GATEWAY_UNIT_PATH:-/etc/systemd/system/openclaw-gateway.service}"
    if [[ -e "$marker" || -L "$marker" ]]; then
        [[ -f "$marker" && ! -L "$marker" ]] || return 1
        [[ "$(stat -c '%u' -- "$marker")" == "$(id -u "$owner")" ]] || return 1
        (( (8#$(stat -c '%a' -- "$marker") & 0077) == 0 )) || return 1
        ods_pixel_run_as_owner "$owner" "$home" python3 - "$marker" "${INSTALL_DIR:?}" <<'PY'
import json, pathlib, sys
value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
if value.get("schema_version") != 1 or value.get("manager") != "ods" or value.get("install_dir") != sys.argv[2]:
    raise SystemExit("Pixel management marker does not match this ODS install")
PY
        return
    fi

    # Never adopt or rewrite an ambient user-managed Pixel/OpenClaw deployment.
    for existing in \
        "$home/.openclaw/openclaw.json" \
        "$home/.config/pixel-agent/gateway.env" \
        "$home/.config/pixel-deployment/onboarding.json" \
        "$gateway_unit"; do
        if [[ -e "$existing" || -L "$existing" ]]; then
            ai_bad "An existing non-ODS Pixel/OpenClaw deployment was found. ODS will not overwrite it."
            return 1
        fi
    done

    ods_pixel_run_as_owner "$owner" "$home" mkdir -p -- "$home/.config/ods"
    ods_pixel_run_as_owner "$owner" "$home" python3 - "$marker" "${INSTALL_DIR:?}" "${PIXEL_SOURCE_REF:?}" <<'PY'
import json, os, pathlib, sys, tempfile
path = pathlib.Path(sys.argv[1])
payload = json.dumps({
    "schema_version": 1,
    "manager": "ods",
    "state": "installing",
    "install_dir": sys.argv[2],
    "pixel_source_ref": sys.argv[3],
}, indent=2, sort_keys=True) + "\n"
fd, temporary = tempfile.mkstemp(prefix=".pixel-managed.", dir=path.parent)
try:
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
PY
}

_ods_pixel_record_verified_state() {
    local owner="$1" home="$2" contract_sha256="$3" state="$4" marker config
    [[ "$contract_sha256" =~ ^[0-9a-f]{64}$ ]] || return 1
    [[ "$state" == installing || "$state" == ready ]] || return 1
    marker="$home/.config/ods/pixel-managed.json"
    config="$home/.openclaw/openclaw.json"
    ods_pixel_run_as_owner "$owner" "$home" python3 - "$marker" "$config" "${INSTALL_DIR:?}" "${PIXEL_SOURCE_REF:?}" "$contract_sha256" "$state" <<'PY'
import hashlib, json, os, pathlib, stat, sys, tempfile

path = pathlib.Path(sys.argv[1])
info = path.lstat()
if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_size > 65536:
    raise SystemExit("invalid Pixel management marker")
value = json.loads(path.read_text(encoding="utf-8"))
if value.get("schema_version") != 1 or value.get("manager") != "ods" or value.get("install_dir") != sys.argv[3]:
    raise SystemExit("Pixel management marker does not match this ODS install")
config_path = pathlib.Path(sys.argv[2])
config_info = config_path.lstat()
if (not stat.S_ISREG(config_info.st_mode) or stat.S_ISLNK(config_info.st_mode)
        or config_info.st_uid != os.getuid() or config_info.st_mode & 0o077
        or config_info.st_size > 2 * 1024 * 1024):
    raise SystemExit("invalid ODS-managed OpenClaw configuration")
config = json.loads(config_path.read_text(encoding="utf-8"))
if not isinstance(config, dict):
    raise SystemExit("invalid ODS-managed OpenClaw configuration")
canonical_config = json.dumps(config, sort_keys=True, separators=(",", ":")).encode()
if sys.argv[6] not in {"installing", "ready"}:
    raise SystemExit("invalid Pixel management state")
value["state"] = sys.argv[6]
value["pixel_source_ref"] = sys.argv[4]
value["contract_sha256"] = sys.argv[5]
value["configuration_sha256"] = hashlib.sha256(b"ods-pixel-openclaw-v1\0" + canonical_config).hexdigest()
fd, temporary = tempfile.mkstemp(prefix=".pixel-managed.", dir=path.parent)
try:
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
PY
}

_ods_pixel_mark_verified_installing() {
    _ods_pixel_record_verified_state "$1" "$2" "$3" installing
}

_ods_pixel_mark_ready() {
    _ods_pixel_record_verified_state "$1" "$2" "$3" ready
}

_ods_pixel_contract_sha256() {
    local owner="$1" home="$2" answers="$3"
    ods_pixel_run_as_owner "$owner" "$home" python3 - "$answers" <<'PY'
import hashlib, os, pathlib, stat, sys

path = pathlib.Path(sys.argv[1])
info = path.lstat()
if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid()
        or info.st_mode & 0o077 or info.st_size > 2 * 1024 * 1024):
    raise SystemExit("invalid ODS Pixel onboarding contract")
payload = path.read_bytes()
print(hashlib.sha256(b"ods-pixel-contract-v1\0" + payload).hexdigest())
PY
}

_ods_pixel_managed_contract_matches() {
    local owner="$1" home="$2" contract_sha256="$3" marker config
    [[ "$contract_sha256" =~ ^[0-9a-f]{64}$ ]] || return 1
    marker="$home/.config/ods/pixel-managed.json"
    config="$home/.openclaw/openclaw.json"
    ods_pixel_run_as_owner "$owner" "$home" python3 - "$marker" "$config" "${INSTALL_DIR:?}" "${PIXEL_SOURCE_REF:?}" "$contract_sha256" <<'PY'
import hashlib, json, os, pathlib, stat, sys

path = pathlib.Path(sys.argv[1])
info = path.lstat()
if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid()
        or info.st_size > 65536 or info.st_mode & 0o077):
    raise SystemExit(1)
value = json.loads(path.read_text(encoding="utf-8"))
expected = {
    "schema_version": 1,
    "manager": "ods",
    "install_dir": sys.argv[3],
    "pixel_source_ref": sys.argv[4],
    "contract_sha256": sys.argv[5],
}
if value.get("state") not in {"ready", "installing"} or any(value.get(key) != item for key, item in expected.items()):
    raise SystemExit(1)
config_path = pathlib.Path(sys.argv[2])
config_info = config_path.lstat()
if (not stat.S_ISREG(config_info.st_mode) or stat.S_ISLNK(config_info.st_mode)
        or config_info.st_uid != os.getuid() or config_info.st_mode & 0o077
        or config_info.st_size > 2 * 1024 * 1024):
    raise SystemExit(1)
config = json.loads(config_path.read_text(encoding="utf-8"))
if not isinstance(config, dict):
    raise SystemExit(1)
canonical_config = json.dumps(config, sort_keys=True, separators=(",", ":")).encode()
observed = hashlib.sha256(b"ods-pixel-openclaw-v1\0" + canonical_config).hexdigest()
if value.get("configuration_sha256") != observed:
    raise SystemExit(1)
PY
}

_ods_pixel_mark_installing() {
    local owner="$1" home="$2" marker
    marker="$home/.config/ods/pixel-managed.json"
    ods_pixel_run_as_owner "$owner" "$home" python3 - "$marker" "${INSTALL_DIR:?}" "${PIXEL_SOURCE_REF:?}" <<'PY'
import json, os, pathlib, stat, sys, tempfile

path = pathlib.Path(sys.argv[1])
info = path.lstat()
if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_size > 65536:
    raise SystemExit("invalid Pixel management marker")
value = json.loads(path.read_text(encoding="utf-8"))
if value.get("schema_version") != 1 or value.get("manager") != "ods" or value.get("install_dir") != sys.argv[2]:
    raise SystemExit("Pixel management marker does not match this ODS install")
value["state"] = "installing"
value["pixel_source_ref"] = sys.argv[3]
fd, temporary = tempfile.mkstemp(prefix=".pixel-managed.", dir=path.parent)
try:
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
PY
}

ods_pixel_prepare_runtime_identity() {
    [[ "${ENABLE_PIXEL_RUNTIME:-false}" == true ]] || return 0
    ods_sudo_available || {
        ai_bad "Pixel requires privileged systemd and group setup on this host."
        return 1
    }

    local owner gid
    owner="$(ods_pixel_install_owner)" || return 1
    if ! getent group ods-pixel >/dev/null 2>&1; then
        ods_sudo groupadd --system ods-pixel
    fi
    ods_sudo usermod -aG ods-pixel "$owner"
    gid="$(getent group ods-pixel | awk -F: 'NR == 1 { print $3 }')"
    [[ "$gid" =~ ^[1-9][0-9]*$ ]] || {
        ai_bad "Could not resolve the ods-pixel group GID."
        return 1
    }
    PIXEL_SERVICE_USER="$owner"
    PIXEL_INGRESS_GID="$gid"
    export PIXEL_SERVICE_USER PIXEL_INGRESS_GID
    if declare -f _phase11_env_set >/dev/null 2>&1; then
        _phase11_env_set PIXEL_INGRESS_GID "$gid"
    fi
    ai_ok "Prepared the unprivileged Pixel runtime identity"
}

_ods_pixel_source_checkout() {
    local owner="$1" home="$2" source_root="$3"
    local source="${PIXEL_SOURCE_URL:?}" ref="${PIXEL_SOURCE_REF:?}"
    [[ "$source_root" == /* && "$source_root" != / && ! -L "$source_root" ]] || return 1

    if [[ ! -e "$source_root" ]]; then
        local parent="${source_root%/*}"
        ods_pixel_run_as_owner "$owner" "$home" mkdir -p -- "$parent"
        if [[ "$source" == https://github.com/Osmantic/Pixel.git ]]; then
            ods_pixel_run_as_owner "$owner" "$home" git clone --filter=blob:none --no-checkout -- "$source" "$source_root" >/dev/null
        else
            ods_pixel_run_as_owner "$owner" "$home" git clone --no-local --no-checkout -- "$source" "$source_root" >/dev/null
        fi
        ods_pixel_run_as_owner "$owner" "$home" git -C "$source_root" -c advice.detachedHead=false checkout --detach "$ref" >/dev/null
    fi

    [[ -d "$source_root/.git" && ! -L "$source_root/.git" ]] || return 1
    [[ "$(ods_pixel_run_as_owner "$owner" "$home" git -C "$source_root" rev-parse HEAD)" == "$ref" ]] || return 1
    ods_pixel_run_as_owner "$owner" "$home" git -C "$source_root" diff --quiet --ignore-submodules --
    ods_pixel_run_as_owner "$owner" "$home" git -C "$source_root" diff --cached --quiet --ignore-submodules --
    printf '%s\n' "$source_root"
}

_ods_pixel_wait_http() {
    local label="$1" url="$2" attempts="${3:-120}" jq_filter="${4:-}"
    local body attempt
    for ((attempt = 1; attempt <= attempts; attempt++)); do
        if body="$(curl --fail --silent --show-error --max-time 8 "$url" 2>/dev/null)"; then
            if [[ -z "$jq_filter" ]] || jq -e "$jq_filter" >/dev/null 2>&1 <<<"$body"; then
                return 0
            fi
        fi
        sleep 2
    done
    ai_bad "$label did not become ready at its loopback endpoint."
    return 1
}

_ods_pixel_enable_chat_endpoint() {
    local owner="$1" home="$2" config
    config="$home/.openclaw/openclaw.json"
    ods_pixel_run_as_owner "$owner" "$home" mkdir -p -- "$home/.openclaw"
    ods_pixel_run_as_owner "$owner" "$home" python3 - "$config" <<'PY'
import json, os, pathlib, stat, sys, tempfile

path = pathlib.Path(sys.argv[1])
if path.is_symlink():
    raise SystemExit("OpenClaw config cannot be a symlink")
value = {}
if path.exists():
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > 2 * 1024 * 1024:
        raise SystemExit("OpenClaw config is not a bounded regular file")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise SystemExit("OpenClaw config must be an object")
gateway = value.setdefault("gateway", {})
http = gateway.setdefault("http", {})
endpoints = http.setdefault("endpoints", {})
endpoints["chatCompletions"] = {"enabled": True}
fd, temporary = tempfile.mkstemp(prefix=".openclaw.", dir=path.parent)
try:
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
PY
}

_ods_pixel_write_onboarding() {
    local owner="$1" home="$2" answers="$3" openclaw_bin="$4" plugin_path="$5" plugin_digest="$6"
    local context="${MAX_CONTEXT:-16384}" max_tokens=4096 reasoning=false
    [[ "$context" =~ ^[0-9]+$ && "$context" -ge 4096 ]] || context=16384
    (( context < max_tokens )) && max_tokens="$context"
    [[ "${LLAMA_REASONING:-off}" != off ]] && reasoning=true

    ods_pixel_run_as_owner "$owner" "$home" python3 - "$answers" \
        "$openclaw_bin" "$home" "${LLM_MODEL:-default}" "$context" "$max_tokens" "$reasoning" \
        "${OLLAMA_PORT:-11434}" "${SEARXNG_PORT:-8888}" "$plugin_path" "$plugin_digest" <<'PY'
import json, os, pathlib, stat, sys, tempfile

(out, openclaw_bin, home, model, context, max_tokens, reasoning,
 model_port, search_port, plugin_path, plugin_digest) = sys.argv[1:]
home = pathlib.Path(home)
payload = {
    "deploymentProfile": "prepared",
    "capabilityProfile": "minimal",
    "ownerName": "ODS Owner",
    "organization": "Local ODS",
    "deploymentName": "ods-default",
    "timeZone": "UTC",
    "agentId": "pixel",
    "agentName": "Pixel",
    "openclawBin": openclaw_bin,
    "openclawHome": str(home / ".openclaw"),
    "installDir": str(home / ".local" / "share" / "pixel"),
    "workspace": str(home / ".openclaw" / "workspace-pixel"),
    "modelProvider": "ods-local",
    "modelId": model,
    "modelName": f"ODS Local {model}",
    "modelBaseUrl": f"http://127.0.0.1:{model_port}/v1",
    "modelApiKey": "local-no-auth",
    "modelReasoning": reasoning == "true",
    "modelContextWindow": int(context),
    "modelMaxTokens": int(max_tokens),
    "modelPrivateHosts": [],
    "searxngBaseUrl": f"http://127.0.0.1:{search_port}",
    "embeddingModel": "embeddinggemma-300m-qat-Q8_0.gguf",
    "embeddingCache": str(home / ".cache" / "openclaw" / "embeddings"),
    "googleAccount": "ods@localhost.local",
    "calendarId": "primary",
    "gatewayPort": 18789,
    "gatewayExtensions": [{
        "id": "pixel-ods",
        "path": plugin_path,
        "sha256": plugin_digest,
        "tools": ["pixel_ods_status", "pixel_ods_apps_list"],
    }],
    "localCapabilityPacks": [],
    "agentSkills": [],
    "emailLimbEnabled": False,
    "calendarLimbEnabled": False,
    "calendarDirectEnabled": False,
    "socialLimbEnabled": False,
    "webLimbEnabled": False,
    "operationsLimbEnabled": False,
    "frontierLimbEnabled": False,
    "frontierAuthMode": "api-key",
    # Pixel still validates the managed Frontier policy while the limb is
    # disabled. Use its smallest built-in budget rather than "custom", which
    # is reserved for a separate private policy and otherwise renders an empty
    # budget object during configure.
    "frontierBudgetProfile": "starter",
    "frontierTaskPacks": [],
    "operationsActionPacks": [],
}
path = pathlib.Path(out)
path.parent.mkdir(parents=True, exist_ok=True)
if path.is_symlink():
    raise SystemExit("ODS Pixel onboarding contract cannot be a symlink")
if path.exists():
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > 2 * 1024 * 1024:
        raise SystemExit("invalid existing ODS Pixel onboarding contract")
content = json.dumps(payload, indent=2, sort_keys=True) + "\n"
fd, temporary = tempfile.mkstemp(prefix=".pixel-onboarding.", dir=path.parent)
try:
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
PY
}

_ods_pixel_install_ingress() {
    local owner="$1" home="$2" plugin_root="$3"
    local token_file="$home/.openclaw/openclaw.json"
    local runtime_token_file="/run/ods-pixel/openclaw.json"
    [[ -f "$token_file" && ! -L "$token_file" ]] || return 1
    [[ "$(stat -c '%u' -- "$token_file")" == "$(id -u "$owner")" ]] || return 1
    (( (8#$(stat -c '%a' -- "$token_file") & 0077) == 0 )) || return 1

    local stage
    stage="$(mktemp -d)" || return 1
    python3 - "$plugin_root/host/pixel-ingress.service" "$stage/pixel-ingress.service" "$owner" "$token_file" "$runtime_token_file" <<'PY'
import pathlib, sys

source, target, owner, token_source, token_file = sys.argv[1:6]
text = pathlib.Path(source).read_text(encoding="utf-8")
if any(c in owner + token_source + token_file for c in "\n\r\0"):
    raise SystemExit("unsafe systemd substitution")
text = (text.replace("__PIXEL_SERVICE_USER__", owner)
            .replace("__PIXEL_GATEWAY_TOKEN_SOURCE__", token_source)
            .replace("__PIXEL_GATEWAY_TOKEN_FILE__", token_file))
if "__PIXEL_" in text:
    raise SystemExit("unresolved Pixel systemd placeholder")
pathlib.Path(target).write_text(text, encoding="utf-8", newline="\n")
PY
    cat > "$stage/pixel-agent.env" <<EOF
PIXEL_INGRESS_SOCKET=/run/ods-pixel/pixel-ingress.sock
PIXEL_INGRESS_GID=${PIXEL_INGRESS_GID:?}
PIXEL_GATEWAY_TOKEN_FILE=$runtime_token_file
PIXEL_GATEWAY_PORT=18789
PIXEL_STATUS_FILE=/run/ods-pixel/ods-status.json
PIXEL_STATUS_INTERVAL_MS=30000
EOF
    chmod 0640 "$stage/pixel-agent.env"
    ods_sudo install -d -m 0755 /usr/local/libexec /etc/ods
    ods_sudo install -o root -g root -m 0755 "$plugin_root/host/pixel_ingress.mjs" /usr/local/libexec/ods-pixel-ingress.mjs
    ods_sudo install -o root -g ods-pixel -m 0640 "$stage/pixel-agent.env" /etc/ods/pixel-agent.env
    ods_sudo install -o root -g root -m 0644 "$stage/pixel-ingress.service" /etc/systemd/system/pixel-ingress.service
    rm -f -- "$stage/pixel-agent.env" "$stage/pixel-ingress.service"
    rmdir -- "$stage"
    ods_sudo systemctl daemon-reload
    ods_sudo systemctl enable --now openclaw-gateway.service pixel-ingress.service
    ods_sudo systemctl is-active --quiet openclaw-gateway.service pixel-ingress.service
}

ods_pixel_install_default_agent() {
    [[ "${ENABLE_PIXEL_RUNTIME:-false}" == true ]] || return 0
    local owner home source_root pixel_root plugin_root answers openclaw_bin plugin_digest contract_sha256
    local reuse_active=false
    owner="${PIXEL_SERVICE_USER:-$(ods_pixel_install_owner)}" || return 1
    home="$(ods_pixel_owner_home "$owner")" || return 1
    _ods_pixel_assert_managed_state "$owner" "$home" || return 1
    source_root="${INSTALL_DIR:?}/data/pixel/source-${PIXEL_SOURCE_REF:?}"
    pixel_root="$(_ods_pixel_source_checkout "$owner" "$home" "$source_root")" || {
        ai_bad "Pixel source checkout is absent, changed, or not at the configured exact commit."
        return 1
    }
    plugin_root="${INSTALL_DIR:?}/extensions/services/pixel-agent"
    [[ -f "$plugin_root/plugin/openclaw.plugin.json" && -f "$plugin_root/host/pixel_ingress.mjs" ]] || return 1

    ai "Starting the local model and search prerequisites for Pixel review..."
    $DOCKER_COMPOSE_CMD "${COMPOSE_FLAGS_ARR[@]}" up -d --no-build --pull never llama-server searxng >>"$LOG_FILE" 2>&1
    _ods_pixel_wait_http "ODS local model" "http://127.0.0.1:${OLLAMA_PORT:-11434}/v1/models" 180 '.data | type == "array" and length > 0'
    _ods_pixel_wait_http "ODS local search" "http://127.0.0.1:${SEARXNG_PORT:-8888}/search?q=pixel-preflight&format=json" 90 '.results | type == "array"'

    ai "Bootstrapping the exact Pixel source and pinned runtime..."
    if ! declare -f ods_linux_node_tools_available >/dev/null 2>&1 \
        || ! ods_linux_node_tools_available; then
        ai_bad "Pixel requires Linux Node.js 20+ and Linux npm; Windows-mounted WSL tools are not accepted."
        return 1
    fi
    if ! ods_pixel_run_as_owner "$owner" "$home" "$pixel_root/pixel" bootstrap --apply >>"$LOG_FILE" 2>&1; then
        ai_bad "Pixel bootstrap failed. See $LOG_FILE for the exact Pixel error."
        return 1
    fi
    # Expansion is intentionally performed in the owner shell, not here.
    # shellcheck disable=SC2016
    openclaw_bin="$(ods_pixel_run_as_owner "$owner" "$home" bash -c 'if [[ -x "$HOME/.npm-global/bin/openclaw" ]]; then printf "%s\\n" "$HOME/.npm-global/bin/openclaw"; else command -v openclaw; fi')"
    [[ "$openclaw_bin" == /* && -x "$openclaw_bin" ]] || return 1
    plugin_digest="$(ods_pixel_run_as_owner "$owner" "$home" "$pixel_root/pixel" extension-hash "$plugin_root/plugin")"
    [[ "$plugin_digest" =~ ^[0-9a-f]{64}$ ]] || return 1

    answers="$INSTALL_DIR/data/pixel/onboarding.json"
    if ! _ods_pixel_write_onboarding "$owner" "$home" "$answers" "$openclaw_bin" "$plugin_root/plugin" "$plugin_digest"; then
        ai_bad "Could not write the ODS-managed Pixel onboarding contract."
        return 1
    fi
    contract_sha256="$(_ods_pixel_contract_sha256 "$owner" "$home" "$answers")" || {
        ai_bad "Could not hash the ODS-managed Pixel onboarding contract."
        return 1
    }
    [[ "$contract_sha256" =~ ^[0-9a-f]{64}$ ]] || return 1
    if _ods_pixel_managed_contract_matches "$owner" "$home" "$contract_sha256"; then
        reuse_active=true
    fi
    _ods_pixel_mark_installing "$owner" "$home" || return 1
    if ! _ods_pixel_enable_chat_endpoint "$owner" "$home"; then
        ai_bad "Could not enable Pixel's loopback chat endpoint."
        return 1
    fi
    if [[ "$reuse_active" == true ]]; then
        ai "The exact ODS-managed Pixel contract is already active; verifying it without reapplying the same release..."
        if ! ods_pixel_run_as_owner "$owner" "$home" "$pixel_root/pixel" verify >>"$LOG_FILE" 2>&1; then
            ai_bad "The existing ODS-managed Pixel contract failed exact-source verification. See $LOG_FILE."
            return 1
        fi
    else
        if ! {
            ods_pixel_run_as_owner "$owner" "$home" "$pixel_root/pixel" configure --answers "$answers" --force &&
            ods_pixel_run_as_owner "$owner" "$home" "$pixel_root/pixel" plan &&
            ods_pixel_run_as_owner "$owner" "$home" "$pixel_root/pixel" apply --confirm &&
            ods_pixel_run_as_owner "$owner" "$home" "$pixel_root/pixel" verify
        } >>"$LOG_FILE" 2>&1; then
            ai_bad "Pixel configure, plan, apply, or verify failed. See $LOG_FILE for the exact Pixel error."
            return 1
        fi
    fi
    # Bind the exact verified contract and canonical live config while the
    # marker remains non-ready. If ingress setup is interrupted, a rerun can
    # verify and reuse this same active Pixel release instead of attempting an
    # unsafe same-version reapply.
    if ! _ods_pixel_mark_verified_installing "$owner" "$home" "$contract_sha256"; then
        ai_bad "Could not bind the verified Pixel contract for retry-safe ingress setup."
        return 1
    fi
    if ! _ods_pixel_install_ingress "$owner" "$home" "$plugin_root"; then
        ai_bad "Could not install and start the private Pixel ingress."
        return 1
    fi
    # sudo -u starts a fresh owner session with the newly assigned ods-pixel
    # supplementary group; the original installer shell may not see that group
    # until the next login.
    if ! ods_pixel_run_as_owner "$owner" "$home" curl --fail --silent --show-error --max-time 10 \
        --unix-socket /run/ods-pixel/pixel-ingress.sock http://localhost/health >/dev/null; then
        ai_bad "Pixel ingress did not pass its authenticated loopback health check."
        return 1
    fi
    if ! _ods_pixel_mark_ready "$owner" "$home" "$contract_sha256"; then
        ai_bad "Could not record the verified Pixel runtime as ready."
        return 1
    fi
    ai_ok "Pixel is installed, verified, and ready on the private ODS ingress"
}
