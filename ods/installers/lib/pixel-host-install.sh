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
    local owner="$1" home="$2" marker marker_dir pixel_install
    marker="$home/.config/ods/pixel-managed.json"
    marker_dir="${marker%/*}"
    pixel_install="$home/.local/share/pixel"
    local gateway_unit="${ODS_PIXEL_GATEWAY_UNIT_PATH:-/etc/systemd/system/openclaw-gateway.service}"
    if [[ -e "$marker_dir" || -L "$marker_dir" ]]; then
        [[ -d "$marker_dir" && ! -L "$marker_dir" ]] || return 1
        [[ "$(stat -c '%u' -- "$marker_dir")" == "$(id -u "$owner")" ]] || return 1
        ods_pixel_run_as_owner "$owner" "$home" chmod 0700 -- "$marker_dir" || return 1
    else
        ods_pixel_run_as_owner "$owner" "$home" install -d -m 0700 -- "$marker_dir" || return 1
    fi
    if [[ -e "$marker" || -L "$marker" ]]; then
        [[ -f "$marker" && ! -L "$marker" ]] || return 1
        [[ "$(stat -c '%u' -- "$marker")" == "$(id -u "$owner")" ]] || return 1
        (( (8#$(stat -c '%a' -- "$marker") & 0077) == 0 )) || return 1
        ods_pixel_run_as_owner "$owner" "$home" python3 - "$marker" "${INSTALL_DIR:?}" <<'PY'
import json, pathlib, sys
value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
if (value.get("schema_version") not in {1, 2} or value.get("manager") != "ods"
        or value.get("install_dir") != sys.argv[2]):
    raise SystemExit("Pixel management marker does not match this ODS install")
if value.get("schema_version") == 2 and value.get("initial_active_state") != "absent":
    raise SystemExit("Pixel management marker has no safe pre-install state")
PY
        return
    fi

    # Never adopt or rewrite an ambient user-managed Pixel/OpenClaw deployment.
    for existing in \
        "$home/.openclaw/openclaw.json" \
        "$home/.config/pixel-agent/gateway.env" \
        "$home/.config/pixel-deployment/onboarding.json" \
        "$pixel_install/current" \
        "$pixel_install/runtime-attestation.json" \
        "$gateway_unit"; do
        if [[ -e "$existing" || -L "$existing" ]]; then
            ai_bad "An existing non-ODS Pixel/OpenClaw deployment was found. ODS will not overwrite it."
            return 1
        fi
    done

    ods_pixel_run_as_owner "$owner" "$home" python3 - "$marker" "${INSTALL_DIR:?}" "${PIXEL_SOURCE_REF:?}" <<'PY'
import json, os, pathlib, sys, tempfile
path = pathlib.Path(sys.argv[1])
payload = json.dumps({
    "schema_version": 2,
    "manager": "ods",
    "state": "installing",
    "initial_active_state": "absent",
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

# Return 0 when an exact ODS-managed Pixel deployment must be retired before
# the installer copies newer source over the installed ownership evidence.
# Return 1 when no transition is needed, and 2 for unsafe or ambiguous state.
_ods_pixel_source_transition_required() {
    local owner="$1" home="$2" requested_ref="$3" marker
    marker="$home/.config/ods/pixel-managed.json"
    [[ "$requested_ref" =~ ^[0-9a-f]{40}$ ]] || return 2
    if [[ ! -e "$marker" && ! -L "$marker" ]]; then
        return 1
    fi
    ods_pixel_run_as_owner "$owner" "$home" python3 - \
        "$marker" "${INSTALL_DIR:?}" "$requested_ref" <<'PY'
import json, os, pathlib, re, stat, sys

path = pathlib.Path(sys.argv[1])
info = path.lstat()
if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode)
        or info.st_nlink != 1 or info.st_uid != os.getuid()
        or info.st_mode & 0o077 or info.st_size > 65536):
    raise SystemExit(2)
value = json.loads(path.read_text(encoding="utf-8"))
source_ref = value.get("pixel_source_ref")
requested_ref = sys.argv[3]
if (value.get("schema_version") != 2 or value.get("manager") != "ods"
        or value.get("initial_active_state") != "absent"
        or value.get("install_dir") != sys.argv[2]
        or value.get("state") not in {"ready", "installing", "deactivating"}
        or not isinstance(source_ref, str)
        or not re.fullmatch(r"[0-9a-f]{40}", source_ref)
        or value.get("requested_source_ref") not in {None, source_ref, requested_ref}):
    raise SystemExit(2)
raise SystemExit(0 if value.get("state") == "deactivating" or source_ref != requested_ref else 1)
PY
}

_ods_pixel_record_verified_state() {
    local owner="$1" home="$2" contract_sha256="$3" state="$4" pixel_root="$5"
    local marker config manifest sandbox_image sandbox_image_id
    [[ "$contract_sha256" =~ ^[0-9a-f]{64}$ ]] || return 1
    [[ "$state" == installing || "$state" == ready ]] || return 1
    marker="$home/.config/ods/pixel-managed.json"
    config="$home/.openclaw/openclaw.json"
    manifest="$pixel_root/RELEASE-MANIFEST.json"
    sandbox_image="$(ods_pixel_run_as_owner "$owner" "$home" python3 - "$manifest" <<'PY'
import json, pathlib, re, sys
path = pathlib.Path(sys.argv[1])
value = json.loads(path.read_text(encoding="utf-8"))
image = value.get("sandboxImage") if isinstance(value, dict) else None
if not isinstance(image, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,255}:[A-Za-z0-9][A-Za-z0-9._-]{0,127}", image):
    raise SystemExit("invalid Pixel sandbox image reference")
print(image)
PY
)" || return 1
    sandbox_image_id="$(ods_pixel_run_as_owner "$owner" "$home" timeout 30s docker image inspect \
        --format '{{.Id}}' "$sandbox_image")" || return 1
    [[ "$sandbox_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
    ods_pixel_run_as_owner "$owner" "$home" python3 - \
        "$marker" "$config" "${INSTALL_DIR:?}" "${PIXEL_SOURCE_REF:?}" \
        "$contract_sha256" "$state" "$home" "$sandbox_image" "$sandbox_image_id" <<'PY'
import hashlib, json, os, pathlib, stat, sys, tempfile

path = pathlib.Path(sys.argv[1])
info = path.lstat()
if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1
        or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 65536):
    raise SystemExit("invalid Pixel management marker")
value = json.loads(path.read_text(encoding="utf-8"))
if (value.get("schema_version") != 2 or value.get("manager") != "ods"
        or value.get("install_dir") != sys.argv[3]
        or value.get("initial_active_state") != "absent"):
    raise SystemExit("Pixel management marker does not match this ODS install")
if value.get("requested_source_ref") not in {None, sys.argv[4]}:
    raise SystemExit("Pixel management marker requested source does not match the verified source")
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

home = pathlib.Path(sys.argv[7])
install_root = home / ".local/share/pixel"
releases_root = install_root / "releases"
current = install_root / "current"
current_info = current.lstat()
if not stat.S_ISLNK(current_info.st_mode) or current_info.st_uid != os.getuid():
    raise SystemExit("invalid active Pixel release link")
release = current.resolve(strict=True)
releases_info = releases_root.lstat()
release_info = release.lstat()
if (not stat.S_ISDIR(releases_info.st_mode) or stat.S_ISLNK(releases_info.st_mode)
        or releases_info.st_uid != os.getuid() or releases_info.st_mode & 0o022
        or not stat.S_ISDIR(release_info.st_mode) or stat.S_ISLNK(release_info.st_mode)
        or release_info.st_uid != os.getuid() or release_info.st_mode & 0o022
        or release.parent.resolve(strict=True) != releases_root.resolve(strict=True)):
    raise SystemExit("active Pixel release is outside its release root")

def regular_file(item: pathlib.Path, maximum: int, private: bool = False) -> bytes:
    details = item.lstat()
    if (not stat.S_ISREG(details.st_mode) or stat.S_ISLNK(details.st_mode)
            or details.st_uid != os.getuid() or details.st_nlink != 1
            or details.st_size > maximum or details.st_mode & 0o022
            or (private and details.st_mode & 0o077)):
        raise SystemExit(f"unsafe verified Pixel artifact: {item}")
    return item.read_bytes()

identity_bytes = regular_file(release / "release-identity.json", 65536)
manifest_bytes = regular_file(release / "install-manifest.sha256", 2 * 1024 * 1024)
attestation_bytes = regular_file(install_root / "runtime-attestation.json", 2 * 1024 * 1024, private=True)
identity = json.loads(identity_bytes)
attestation = json.loads(attestation_bytes)
version = identity.get("pixel") if isinstance(identity, dict) else None
source = identity.get("source") if isinstance(identity, dict) else None
if (not isinstance(version, str) or release.name != version
        or not isinstance(source, dict) or source.get("state") != "git-clean"
        or source.get("commit") != sys.argv[4]):
    raise SystemExit("active Pixel release is not bound to the configured source")
identity_sha256 = hashlib.sha256(identity_bytes).hexdigest()
manifest_sha256 = hashlib.sha256(manifest_bytes).hexdigest()
if (not isinstance(attestation, dict) or attestation.get("kind") != "pixel-runtime-attestation"
        or attestation.get("status") not in {"verified", "limited"}
        or attestation.get("pixel") != version or attestation.get("source") != source
        or not isinstance(attestation.get("release"), dict)
        or attestation["release"].get("sourceIdentitySha256") != identity_sha256
        or attestation["release"].get("installManifestSha256") != manifest_sha256):
    raise SystemExit("Pixel runtime attestation does not bind the active release")
if not isinstance(sys.argv[8], str) or not isinstance(sys.argv[9], str):
    raise SystemExit("invalid Pixel sandbox binding")

value["state"] = sys.argv[6]
value["pixel_source_ref"] = sys.argv[4]
value.pop("requested_source_ref", None)
value["contract_sha256"] = sys.argv[5]
value["configuration_sha256"] = hashlib.sha256(b"ods-pixel-openclaw-v1\0" + canonical_config).hexdigest()
value["active_release_version"] = version
value["release_identity_sha256"] = identity_sha256
value["install_manifest_sha256"] = manifest_sha256
value["sandbox_image"] = sys.argv[8]
value["sandbox_image_id"] = sys.argv[9]
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
    _ods_pixel_record_verified_state "$1" "$2" "$3" installing "$4"
}

_ods_pixel_mark_ready() {
    _ods_pixel_record_verified_state "$1" "$2" "$3" ready "$4"
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
    "schema_version": 2,
    "manager": "ods",
    "initial_active_state": "absent",
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
for key in ("release_identity_sha256", "install_manifest_sha256"):
    item = value.get(key)
    if not isinstance(item, str) or len(item) != 64 or any(ch not in "0123456789abcdef" for ch in item):
        raise SystemExit(1)
if (not isinstance(value.get("active_release_version"), str)
        or not isinstance(value.get("sandbox_image"), str)
        or not isinstance(value.get("sandbox_image_id"), str)
        or len(value["sandbox_image_id"]) != 71 or not value["sandbox_image_id"].startswith("sha256:")
        or any(ch not in "0123456789abcdef" for ch in value["sandbox_image_id"][7:])):
    raise SystemExit(1)
PY
}

_ods_pixel_verified_source_matches() {
    local owner="$1" home="$2" marker
    marker="$home/.config/ods/pixel-managed.json"
    ods_pixel_run_as_owner "$owner" "$home" python3 - "$marker" "${INSTALL_DIR:?}" "${PIXEL_SOURCE_REF:?}" <<'PY'
import json, os, pathlib, stat, sys

path = pathlib.Path(sys.argv[1])
info = path.lstat()
if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode)
        or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 65536):
    raise SystemExit(1)
value = json.loads(path.read_text(encoding="utf-8"))
if (value.get("schema_version") != 2 or value.get("manager") != "ods"
        or value.get("initial_active_state") != "absent"
        or value.get("install_dir") != sys.argv[2]
        or value.get("pixel_source_ref") != sys.argv[3]
        or value.get("state") not in {"ready", "installing"}):
    raise SystemExit(1)
for key in ("contract_sha256", "configuration_sha256", "release_identity_sha256", "install_manifest_sha256"):
    item = value.get(key)
    if not isinstance(item, str) or len(item) != 64 or any(ch not in "0123456789abcdef" for ch in item):
        raise SystemExit(1)
PY
}

_ods_pixel_candidate_config_matches_live() {
    local owner="$1" home="$2" candidate="$3" live
    live="$home/.openclaw/openclaw.json"
    ods_pixel_run_as_owner "$owner" "$home" python3 - "$live" "$candidate" <<'PY'
import json, os, pathlib, stat, sys

values = []
for raw in sys.argv[1:]:
    path = pathlib.Path(raw)
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode)
            or info.st_uid != os.getuid() or info.st_mode & 0o022
            or info.st_size > 2 * 1024 * 1024):
        raise SystemExit(1)
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise SystemExit(1)
    values.append(json.dumps(value, sort_keys=True, separators=(",", ":")))
if values[0] != values[1]:
    raise SystemExit(1)
PY
}

_ods_pixel_managed_source_ref() {
    local owner="$1" home="$2" marker config
    marker="$home/.config/ods/pixel-managed.json"
    config="$home/.openclaw/openclaw.json"
    ods_pixel_run_as_owner "$owner" "$home" python3 - "$marker" "$config" "${INSTALL_DIR:?}" <<'PY'
import hashlib, json, os, pathlib, re, stat, sys

marker_path = pathlib.Path(sys.argv[1])
config_path = pathlib.Path(sys.argv[2])
for path, maximum in ((marker_path, 65536), (config_path, 2 * 1024 * 1024)):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1
            or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > maximum):
        raise SystemExit("unsafe ODS-managed Pixel state")
marker = json.loads(marker_path.read_text(encoding="utf-8"))
source_ref = marker.get("pixel_source_ref")
if (marker.get("schema_version") != 2 or marker.get("manager") != "ods"
        or marker.get("initial_active_state") != "absent"
        or marker.get("install_dir") != sys.argv[3]
        or marker.get("state") not in {"ready", "installing"}
        or not isinstance(source_ref, str) or not re.fullmatch(r"[0-9a-f]{40}", source_ref)
        or marker.get("requested_source_ref") not in {None, source_ref}):
    raise SystemExit("ODS-managed Pixel marker is not eligible for reconciliation")
config = json.loads(config_path.read_text(encoding="utf-8"))
if not isinstance(config, dict):
    raise SystemExit("invalid ODS-managed OpenClaw configuration")
canonical = json.dumps(config, sort_keys=True, separators=(",", ":")).encode()
observed = hashlib.sha256(b"ods-pixel-openclaw-v1\0" + canonical).hexdigest()
if marker.get("configuration_sha256") != observed:
    raise SystemExit("ODS-managed OpenClaw configuration drifted")
print(source_ref)
PY
}

_ods_pixel_model_reconciliation_snapshot() {
    local owner="$1" home="$2" answers="$3" marker config attestation backup_root
    marker="$home/.config/ods/pixel-managed.json"
    config="$home/.openclaw/openclaw.json"
    attestation="$home/.local/share/pixel/runtime-attestation.json"
    backup_root="$home/.openclaw/backups"
    ods_pixel_run_as_owner "$owner" "$home" python3 - \
        "$marker" "$config" "$answers" "$attestation" "$backup_root" <<'PY'
import json, os, pathlib, shutil, stat, sys, tempfile

marker, config, answers, attestation, backup_root = map(pathlib.Path, sys.argv[1:])
sources = (
    (marker, 65536),
    (config, 2 * 1024 * 1024),
    (answers, 2 * 1024 * 1024),
    (attestation, 2 * 1024 * 1024),
)
for path, maximum in sources:
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1
            or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > maximum):
        raise SystemExit(f"unsafe Pixel reconciliation source: {path}")
backup_root.mkdir(mode=0o700, parents=True, exist_ok=True)
root_info = backup_root.lstat()
if (not stat.S_ISDIR(root_info.st_mode) or stat.S_ISLNK(root_info.st_mode)
        or root_info.st_uid != os.getuid() or root_info.st_mode & 0o077):
    raise SystemExit("unsafe Pixel backup root")
backup = pathlib.Path(tempfile.mkdtemp(prefix="ods-model-reconcile-", dir=backup_root))
os.chmod(backup, 0o700)
for source, name in (
    (marker, "pixel-managed.json"),
    (config, "openclaw.json"),
    (answers, "onboarding.json"),
    (attestation, "runtime-attestation.json"),
):
    target = backup / name
    with source.open("rb") as source_handle, target.open("xb") as target_handle:
        shutil.copyfileobj(source_handle, target_handle)
        target_handle.flush()
        os.fsync(target_handle.fileno())
    os.chmod(target, 0o600)

live = json.loads(config.read_text(encoding="utf-8"))
contract = json.loads(answers.read_text(encoding="utf-8"))
provider = contract.get("modelProvider")
agent_id = contract.get("agentId")
providers = live.get("models", {}).get("providers", {})
models = providers.get(provider, {}).get("models", []) if isinstance(providers, dict) else []
agents = live.get("agents", {}).get("list", [])
agent = [item for item in agents if isinstance(item, dict) and item.get("id") == agent_id]
if (provider != "ods-local" or agent_id != "pixel" or len(models) != 1 or len(agent) != 1
        or not isinstance(models[0].get("id"), str) or not isinstance(models[0].get("name"), str)
        or agent[0].get("model") != f"{provider}/{models[0]['id']}"):
    raise SystemExit("live Pixel configuration is outside the ODS model-only contract")
contract["modelId"] = models[0]["id"]
contract["modelName"] = models[0]["name"]
rollback = backup / "rollback-onboarding.json"
payload = json.dumps(contract, indent=2, sort_keys=True) + "\n"
with rollback.open("x", encoding="utf-8", newline="\n") as handle:
    handle.write(payload)
    handle.flush()
    os.fsync(handle.fileno())
os.chmod(rollback, 0o600)
print(backup)
PY
}

_ods_pixel_update_onboarding_model() {
    local owner="$1" home="$2" answers="$3" model="$4"
    local context="${5:-}" max_tokens="${6:-}" reasoning="${7:-}"
    ods_pixel_run_as_owner "$owner" "$home" python3 - \
        "$answers" "$model" "$context" "$max_tokens" "$reasoning" <<'PY'
import json, os, pathlib, re, stat, sys, tempfile

path = pathlib.Path(sys.argv[1])
model = sys.argv[2]
context_raw, max_tokens_raw, reasoning_raw = sys.argv[3:6]
if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}", model):
    raise SystemExit("invalid promoted Pixel model id")
info = path.lstat()
if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1
        or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 2 * 1024 * 1024):
    raise SystemExit("unsafe ODS Pixel onboarding contract")
parent_info = path.parent.lstat()
if (not stat.S_ISDIR(parent_info.st_mode) or stat.S_ISLNK(parent_info.st_mode)
        or parent_info.st_uid != os.getuid() or parent_info.st_mode & 0o022):
    raise SystemExit("unsafe ODS Pixel onboarding directory")
value = json.loads(path.read_text(encoding="utf-8"))
extensions = value.get("gatewayExtensions")
if (value.get("deploymentName") != "ods-default" or value.get("agentId") != "pixel"
        or value.get("modelProvider") != "ods-local" or value.get("modelApiKey") != "local-no-auth"
        or value.get("modelBaseUrl") != "http://127.0.0.1:11434/v1"
        or not isinstance(extensions, list) or len(extensions) != 1
        or extensions[0].get("id") != "pixel-ods"):
    raise SystemExit("onboarding contract is outside the ODS-managed Pixel boundary")
if (type(value.get("modelContextWindow")) is not int
        or type(value.get("modelMaxTokens")) is not int
        or type(value.get("modelReasoning")) is not bool
        or not 4096 <= value["modelContextWindow"] <= 10_000_000
        or not 1 <= value["modelMaxTokens"] <= value["modelContextWindow"]):
    raise SystemExit("onboarding model limits are outside the ODS-managed Pixel boundary")
if context_raw:
    if not context_raw.isdigit() or not 4096 <= int(context_raw) <= 10_000_000:
        raise SystemExit("invalid promoted Pixel context window")
    value["modelContextWindow"] = int(context_raw)
if max_tokens_raw:
    if not max_tokens_raw.isdigit() or not 1 <= int(max_tokens_raw) <= value.get("modelContextWindow", 0):
        raise SystemExit("invalid promoted Pixel maximum tokens")
    value["modelMaxTokens"] = int(max_tokens_raw)
elif context_raw and value.get("modelMaxTokens", 0) > value["modelContextWindow"]:
    value["modelMaxTokens"] = value["modelContextWindow"]
if reasoning_raw:
    if reasoning_raw not in {"true", "false"}:
        raise SystemExit("invalid promoted Pixel reasoning capability")
    value["modelReasoning"] = reasoning_raw == "true"
value["modelId"] = model
value["modelName"] = f"ODS Local {model}"
payload = json.dumps(value, indent=2, sort_keys=True) + "\n"
fd, temporary = tempfile.mkstemp(prefix=".pixel-onboarding.", dir=path.parent)
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

_ods_pixel_candidate_is_managed_runtime_update() {
    local owner="$1" home="$2" candidate="$3" answers="$4" live
    live="$home/.openclaw/openclaw.json"
    ods_pixel_run_as_owner "$owner" "$home" python3 - "$live" "$candidate" "$answers" <<'PY'
import copy, json, os, pathlib, stat, sys

values = []
for raw in sys.argv[1:]:
    path = pathlib.Path(raw)
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1
            or info.st_uid != os.getuid() or info.st_mode & 0o077
            or info.st_size > 2 * 1024 * 1024):
        raise SystemExit("unsafe Pixel model-reconciliation input")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise SystemExit("Pixel model-reconciliation input is not an object")
    values.append(value)
live, candidate, contract = values
provider = contract.get("modelProvider")
model_id = contract.get("modelId")
model_name = contract.get("modelName")
agent_id = contract.get("agentId")
if provider != "ods-local" or agent_id != "pixel" or model_name != f"ODS Local {model_id}":
    raise SystemExit("candidate is outside the ODS model contract")

def binding(document):
    providers = document.get("models", {}).get("providers", {})
    if not isinstance(providers, dict) or set(providers) != {provider}:
        raise SystemExit("unexpected Pixel model providers")
    provider_value = providers[provider]
    models = provider_value.get("models") if isinstance(provider_value, dict) else None
    agents = document.get("agents", {}).get("list", [])
    selected = [item for item in agents if isinstance(item, dict) and item.get("id") == agent_id]
    if not isinstance(models, list) or len(models) != 1 or len(selected) != 1:
        raise SystemExit("unexpected Pixel model or agent cardinality")
    return provider_value, models[0], selected[0]

live_provider, live_model, live_agent = binding(live)
candidate_provider, candidate_model, candidate_agent = binding(candidate)
expected_model = {
    "id": model_id,
    "name": model_name,
    "contextWindow": contract.get("modelContextWindow"),
    "maxTokens": contract.get("modelMaxTokens"),
    "reasoning": contract.get("modelReasoning"),
}
for key, expected in expected_model.items():
    if candidate_model.get(key) != expected:
        raise SystemExit(f"candidate model field does not match onboarding: {key}")
if (candidate_provider.get("api") != "openai-completions"
        or candidate_provider.get("apiKey") != contract.get("modelApiKey")
        or candidate_provider.get("baseUrl") != contract.get("modelBaseUrl")
        or candidate_agent.get("model") != f"{provider}/{model_id}"):
    raise SystemExit("candidate provider route does not match onboarding")
old_id = live_model.get("id")
if (not isinstance(old_id, str) or live_model.get("name") != f"ODS Local {old_id}"
        or live_agent.get("model") != f"{provider}/{old_id}"):
    raise SystemExit("live provider route is outside the ODS model contract")
normalized = copy.deepcopy(live)
normalized_provider, normalized_model, normalized_agent = binding(normalized)
normalized_model["id"] = model_id
normalized_model["name"] = model_name
normalized_model["contextWindow"] = contract.get("modelContextWindow")
normalized_model["maxTokens"] = contract.get("modelMaxTokens")
normalized_model["reasoning"] = contract.get("modelReasoning")
normalized_agent["model"] = f"{provider}/{model_id}"
normalized_agents = normalized.get("agents")
normalized_defaults = normalized_agents.get("defaults") if isinstance(normalized_agents, dict) else None
normalized_session = normalized.get("session")
if not isinstance(normalized_defaults, dict) or not isinstance(normalized_session, dict):
    raise SystemExit("live Pixel runtime policy is outside the ODS contract")

# A promoted route may also carry the current deterministic ODS runtime policy.
# Normalize only those exact fields before the whole-document comparison; any
# other candidate change still fails closed below.
normalized_provider["timeoutSeconds"] = 1800
normalized_defaults["timeoutSeconds"] = 1800
# Preserve Pixel's complete workspace operating and tool contracts. The
# shipped AGENTS.md and TOOLS.md files are both larger than 4,000 characters;
# a smaller ODS override silently removes most of their instructions.
normalized_defaults["bootstrapMaxChars"] = 32000
normalized_defaults["bootstrapTotalMaxChars"] = 96000
normalized_defaults["contextInjection"] = "continuation-skip"
normalized_compaction = normalized_defaults.setdefault("compaction", {})
normalized_diagnostics = normalized.setdefault("diagnostics", {})
normalized_write_lock = normalized_session.setdefault("writeLock", {})
normalized_tools = normalized.setdefault("tools", {})
normalized_also_allow = normalized_tools.setdefault("alsoAllow", [])
normalized_web = normalized_tools.setdefault("web", {})
normalized_fetch = normalized_web.setdefault("fetch", {})
normalized_agent_tools = normalized_agent.setdefault("tools", {})
normalized_agent_deny = normalized_agent_tools.setdefault("deny", [])
normalized_sandbox_tools = normalized_tools.setdefault("sandbox", {}).setdefault("tools", {})
normalized_sandbox_allow = normalized_sandbox_tools.setdefault("allow", [])
normalized_agent_sandbox = normalized_defaults.setdefault("sandbox", {})
normalized_sandbox_docker = normalized_agent_sandbox.setdefault("docker", {})
if (not isinstance(normalized_compaction, dict)
        or not isinstance(normalized_diagnostics, dict)
        or not isinstance(normalized_write_lock, dict)
        or not isinstance(normalized_tools, dict)
        or not isinstance(normalized_also_allow, list)
        or not all(isinstance(item, str) for item in normalized_also_allow)
        or not isinstance(normalized_web, dict)
        or not isinstance(normalized_fetch, dict)
        or not isinstance(normalized_agent_tools, dict)
        or not isinstance(normalized_agent_deny, list)
        or not all(isinstance(item, str) for item in normalized_agent_deny)
        or not isinstance(normalized_sandbox_tools, dict)
        or not isinstance(normalized_sandbox_allow, list)
        or not all(isinstance(item, str) for item in normalized_sandbox_allow)
        or not isinstance(normalized_agent_sandbox, dict)
        or not isinstance(normalized_sandbox_docker, dict)):
    raise SystemExit("live Pixel runtime policy is outside the ODS contract")
exec_control_bind = "{}:/run/pixel-ods-control:ro".format(
    pathlib.Path.home() / ".openclaw" / ".ods-exec-control"
)
existing_binds = normalized_sandbox_docker.get("binds", [])
if existing_binds not in ([], [exec_control_bind]):
    raise SystemExit("live Pixel sandbox binds are outside the ODS contract")
normalized_sandbox_docker["binds"] = [exec_control_bind]
normalized_sandbox_docker["dangerouslyAllowExternalBindSources"] = True
normalized_compaction["reserveTokens"] = contract.get("modelMaxTokens")
normalized_compaction["reserveTokensFloor"] = 0
normalized_diagnostics["stuckSessionAbortMs"] = 1860000
normalized_write_lock["maxHoldMs"] = 1920000
normalized_write_lock["staleMs"] = 3600000
normalized_tools["loopDetection"] = {
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
normalized_fetch.update({
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
})
normalized_agent_tools["deny"] = [
    item for item in normalized_agent_deny
    if item not in {
        "web_search", "web_fetch", "pixel_ods_status", "pixel_ods_apps_list",
        "pixel_ods_web_extract", "pixel_web_extract"
    }
]
normalized_also_allow = [item for item in normalized_also_allow if item != "pixel_web_extract"]
normalized_sandbox_allow = [item for item in normalized_sandbox_allow if item != "pixel_web_extract"]
for extension_tool in ("pixel_ods_status", "pixel_ods_apps_list", "pixel_ods_web_extract"):
    if extension_tool not in normalized_also_allow:
        normalized_also_allow.append(extension_tool)
for permitted_tool in (
    "web_search", "web_fetch", "pixel_ods_status", "pixel_ods_apps_list", "pixel_ods_web_extract"
):
    if permitted_tool not in normalized_sandbox_allow:
        normalized_sandbox_allow.append(permitted_tool)
normalized_tools["alsoAllow"] = sorted(set(normalized_also_allow))
normalized_sandbox_tools["allow"] = sorted(set(normalized_sandbox_allow))
model_label = f"{model_id} {model_name}".casefold()
if "qwen" in model_label and contract.get("modelReasoning") is True:
    normalized_model["compat"] = {"thinkingFormat": "qwen-chat-template"}
    normalized_agent["thinkingDefault"] = "low"
else:
    normalized_model.pop("compat", None)
    normalized_agent.pop("thinkingDefault", None)
if normalized != candidate:
    raise SystemExit("candidate changes more than the ODS managed model/runtime fields")
PY
}

_ods_pixel_atomic_replace_managed_file() {
    local owner="$1" home="$2" source="$3" target="$4"
    ods_pixel_run_as_owner "$owner" "$home" python3 - "$source" "$target" <<'PY'
import os, pathlib, stat, sys, tempfile

source = pathlib.Path(sys.argv[1])
target = pathlib.Path(sys.argv[2])
for path in (source,):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1
            or info.st_uid != os.getuid() or info.st_mode & 0o077
            or info.st_size > 2 * 1024 * 1024):
        raise SystemExit(f"unsafe managed file: {path}")
if target.exists() or target.is_symlink():
    info = target.lstat()
    if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1
            or info.st_uid != os.getuid() or info.st_mode & 0o077
            or info.st_size > 2 * 1024 * 1024):
        raise SystemExit(f"unsafe managed file: {target}")
parent_info = target.parent.lstat()
if (not stat.S_ISDIR(parent_info.st_mode) or stat.S_ISLNK(parent_info.st_mode)
        or parent_info.st_uid != os.getuid() or parent_info.st_mode & 0o022):
    raise SystemExit(f"unsafe managed directory: {target.parent}")
payload = source.read_bytes()
fd, temporary = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
try:
    with os.fdopen(fd, "wb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, target)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
PY
}

_ods_pixel_openclaw_bin() {
    local owner="$1" home="$2"
    # Expansion is intentionally performed in the owner shell, not here.
    # shellcheck disable=SC2016
    ods_pixel_run_as_owner "$owner" "$home" bash -c \
        'if [[ -x "$HOME/.npm-global/bin/openclaw" ]]; then printf "%s\\n" "$HOME/.npm-global/bin/openclaw"; else command -v openclaw; fi'
}

_ods_pixel_secure_plugin_tree() {
    local owner="$1" home="$2" plugin_root="$3" expected path
    expected="${INSTALL_DIR:?}/extensions/services/pixel-agent/plugin"
    [[ "$plugin_root" == "$expected" ]] || return 1

    # A source copied from a Windows mount can arrive as mode 0777 even when
    # the Git blob is ordinary read-only code. OpenClaw correctly blocks any
    # plugin below a group/world-writable ancestor, so normalize only this
    # fixed ODS-owned path and fail closed on links, special files, or foreign
    # ownership before calculating the approved extension digest.
    for path in \
        "$INSTALL_DIR" \
        "$INSTALL_DIR/extensions" \
        "$INSTALL_DIR/extensions/services" \
        "$INSTALL_DIR/extensions/services/pixel-agent" \
        "$plugin_root"; do
        [[ -d "$path" && ! -L "$path" ]] || return 1
        [[ "$(stat -c '%u' -- "$path")" == "$(id -u "$owner")" ]] || return 1
        ods_pixel_run_as_owner "$owner" "$home" chmod 0755 -- "$path" || return 1
    done
    if find -P "$plugin_root" -mindepth 1 \( -type l -o ! -user "$owner" \) -print -quit | grep -q .; then
        return 1
    fi
    if find -P "$plugin_root" -mindepth 1 ! -type d ! -type f -print -quit | grep -q .; then
        return 1
    fi
    ods_pixel_run_as_owner "$owner" "$home" find -P "$plugin_root" -type d -exec chmod 0755 -- '{}' + || return 1
    ods_pixel_run_as_owner "$owner" "$home" find -P "$plugin_root" -type f -exec chmod 0644 -- '{}' + || return 1
    if find -P "$plugin_root" -perm /022 -print -quit | grep -q .; then
        return 1
    fi
}

_ods_pixel_refresh_plugin_registry() {
    local owner="$1" home="$2" openclaw_bin="$3" plugin_root="$4" registry
    registry="$(ods_pixel_run_as_owner "$owner" "$home" "$openclaw_bin" \
        plugins registry --refresh --json 2>/dev/null)" || return 1
    jq -e --arg root "$plugin_root" '
        (["pixel_ods_apps_list", "pixel_ods_status", "pixel_ods_web_extract"] | sort) as $tools
        | .refreshed == true
        and .registry.version == 1
        and .registry.refreshReason == "manual"
        and ([
            .registry.plugins[]?
            | select(
                .pluginId == "pixel-ods"
                and .enabled == true
                and .rootDir == $root
                and ((.contributions.contracts.tools // []) | sort) == $tools
            )
        ] | length == 1)
    ' <<<"$registry" >/dev/null
}

_ods_pixel_verify_plugin_loaded() {
    local owner="$1" home="$2" openclaw_bin="$3" plugin_root="$4"
    ods_pixel_run_as_owner "$owner" "$home" "$openclaw_bin" plugins list --json 2>/dev/null \
        | jq -e --arg root "$plugin_root" '
            ["pixel_ods_apps_list", "pixel_ods_status", "pixel_ods_web_extract"] as $tools
            | [
                .plugins[]?
                | select(
                    .id == "pixel-ods"
                    and .status == "loaded"
                    and .rootDir == $root
                    and ((.contracts.tools // []) | sort) == ($tools | sort)
                )
            ] | length == 1
        ' \
            >/dev/null
}

_ods_pixel_install_exec_control() {
    local owner="$1" home="$2" source="$3"
    local parent="$home/.openclaw" root="$home/.openclaw/.ods-exec-control"
    [[ -f "$source" && ! -L "$source" \
        && "$(stat -c '%U' -- "$source")" == "$owner" \
        && "$(stat -c '%h' -- "$source")" == 1 ]] || return 1
    (( (8#$(stat -c '%a' -- "$source") & 0022) == 0 )) || return 1
    [[ -d "$parent" && ! -L "$parent" \
        && "$(stat -c '%U' -- "$parent")" == "$owner" ]] || return 1
    (( (8#$(stat -c '%a' -- "$parent") & 0022) == 0 )) || return 1
    if [[ -e "$root" || -L "$root" ]]; then
        [[ -d "$root" && ! -L "$root" && "$(stat -c '%U' -- "$root")" == "$owner" \
            && "$(stat -c '%a' -- "$root")" == 700 ]] || return 1
    fi
    if [[ -e "$root/cancellable-exec.sh" || -L "$root/cancellable-exec.sh" ]]; then
        [[ -f "$root/cancellable-exec.sh" && ! -L "$root/cancellable-exec.sh" \
            && "$(stat -c '%U' -- "$root/cancellable-exec.sh")" == "$owner" \
            && "$(stat -c '%h' -- "$root/cancellable-exec.sh")" == 1 ]] || return 1
    fi
    ods_pixel_run_as_owner "$owner" "$home" install -d -m 0700 -- "$root" || return 1
    ods_pixel_run_as_owner "$owner" "$home" install -m 0500 -- \
        "$source" "$root/cancellable-exec.sh" || return 1
    [[ -d "$root" && ! -L "$root" && -f "$root/cancellable-exec.sh" \
        && ! -L "$root/cancellable-exec.sh" \
        && "$(stat -c '%U' -- "$root")" == "$owner" \
        && "$(stat -c '%U' -- "$root/cancellable-exec.sh")" == "$owner" \
        && "$(stat -c '%a' -- "$root")" == 700 \
        && "$(stat -c '%h' -- "$root/cancellable-exec.sh")" == 1 \
        && "$(stat -c '%a' -- "$root/cancellable-exec.sh")" == 500 ]]
}

_ods_pixel_recreate_agent_sandbox() {
    local owner="$1" home="$2" openclaw_bin="$3"
    [[ "$openclaw_bin" == /* && -x "$openclaw_bin" ]] || return 1
    ods_pixel_run_as_owner "$owner" "$home" "$openclaw_bin" \
        sandbox recreate --agent pixel --force >/dev/null
}

_ods_pixel_apply_runtime_budget() {
    local owner="$1" home="$2" config="$3" openclaw_bin="$4" staged
    # ODS qualifies Pixel on CPU-only hosts. The first local 9B turn can spend
    # more than five minutes loading and prefilling its managed context, while
    # OpenClaw's default session watchdogs assume a responsive remote model.
    # Keep the larger CPU-only budgets deterministic and confined to this
    # ODS-owned Pixel route.
    # macOS Bash 3.2 reparses this command-substitution heredoc; keep the
    # embedded Python body free of literal apostrophe characters.
    staged="$(ods_pixel_run_as_owner "$owner" "$home" python3 - "$config" <<'PY'
import copy, json, os, pathlib, re, stat, sys, tempfile

path = pathlib.Path(sys.argv[1])
info = path.lstat()
if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1
        or info.st_uid != os.getuid() or info.st_mode & 0o077
        or info.st_size > 2 * 1024 * 1024):
    raise SystemExit("unsafe ODS-managed OpenClaw configuration")
parent_info = path.parent.lstat()
if (not stat.S_ISDIR(parent_info.st_mode) or stat.S_ISLNK(parent_info.st_mode)
        or parent_info.st_uid != os.getuid() or parent_info.st_mode & 0o022):
    raise SystemExit("unsafe ODS-managed OpenClaw configuration directory")
value = json.loads(path.read_text(encoding="utf-8"))
if not isinstance(value, dict):
    raise SystemExit("ODS-managed OpenClaw configuration must be an object")

providers = value.get("models", {}).get("providers", {})
agents = value.get("agents", {})
agent_list = agents.get("list", []) if isinstance(agents, dict) else []
selected = [item for item in agent_list if isinstance(item, dict) and item.get("id") == "pixel"]
if not isinstance(providers, dict) or set(providers) != {"ods-local"} or len(selected) != 1:
    raise SystemExit("OpenClaw configuration is outside the ODS Pixel runtime boundary")
provider = providers["ods-local"]
models = provider.get("models") if isinstance(provider, dict) else None
defaults = agents.get("defaults") if isinstance(agents, dict) else None
session = value.get("session")
model_id = models[0].get("id") if isinstance(models, list) and len(models) == 1 and isinstance(models[0], dict) else None
if (not isinstance(models, list) or len(models) != 1 or not isinstance(models[0], dict)
        or not isinstance(defaults, dict) or not isinstance(session, dict)
        or provider.get("api") != "openai-completions"
        or provider.get("apiKey") != "local-no-auth"
        or selected[0].get("model") != f"ods-local/{model_id}"):
    raise SystemExit("OpenClaw configuration is outside the ODS Pixel runtime contract")

updated = copy.deepcopy(value)
updated_provider = updated["models"]["providers"]["ods-local"]
updated_defaults = updated["agents"]["defaults"]
updated_agent = next(item for item in updated["agents"]["list"] if isinstance(item, dict) and item.get("id") == "pixel")
updated_model = updated_provider["models"][0]
updated_session = updated["session"]
updated_agent_sandbox = updated_defaults.setdefault("sandbox", {})
updated_sandbox_docker = updated_agent_sandbox.setdefault("docker", {})
updated_diagnostics = updated.setdefault("diagnostics", {})
updated_compaction = updated_defaults.setdefault("compaction", {})
write_lock = updated_session.setdefault("writeLock", {})
updated_tools = updated.setdefault("tools", {})
updated_also_allow = updated_tools.setdefault("alsoAllow", [])
updated_web = updated_tools.setdefault("web", {})
updated_fetch = updated_web.setdefault("fetch", {})
updated_agent_tools = updated_agent.setdefault("tools", {})
updated_agent_deny = updated_agent_tools.setdefault("deny", [])
updated_sandbox = updated_tools.setdefault("sandbox", {})
updated_sandbox_tools = updated_sandbox.setdefault("tools", {})
updated_sandbox_allow = updated_sandbox_tools.setdefault("allow", [])
if not isinstance(updated_compaction, dict):
    raise SystemExit("OpenClaw compaction configuration must be an object")
if not isinstance(write_lock, dict):
    raise SystemExit("OpenClaw session write-lock configuration must be an object")
if not isinstance(updated_diagnostics, dict):
    raise SystemExit("OpenClaw diagnostics configuration must be an object")
if not isinstance(updated_agent_sandbox, dict) or not isinstance(updated_sandbox_docker, dict):
    raise SystemExit("OpenClaw sandbox configuration must be an object")
if (not isinstance(updated_tools, dict)
        or not isinstance(updated_also_allow, list)
        or not all(isinstance(item, str) for item in updated_also_allow)
        or not isinstance(updated_agent_tools, dict)
        or not isinstance(updated_agent_deny, list)
        or not all(isinstance(item, str) for item in updated_agent_deny)
        or not isinstance(updated_sandbox, dict)
        or not isinstance(updated_sandbox_tools, dict)
        or not isinstance(updated_sandbox_allow, list)
        or not all(isinstance(item, str) for item in updated_sandbox_allow)):
    raise SystemExit("OpenClaw tool policy is outside the ODS Pixel runtime contract")
if not isinstance(updated_web, dict) or not isinstance(updated_fetch, dict):
    raise SystemExit("OpenClaw web tool policy is outside the ODS Pixel runtime contract")
exec_control_bind = "{}:/run/pixel-ods-control:ro".format(
    pathlib.Path.home() / ".openclaw" / ".ods-exec-control"
)
existing_binds = updated_sandbox_docker.get("binds", [])
if existing_binds not in ([], [exec_control_bind]):
    raise SystemExit("OpenClaw sandbox binds are outside the ODS Pixel runtime contract")
# OpenClaw accepts this owner-private source only with its explicit external
# bind opt-in. ODS still pins the sole source and destination above, validates
# the host tree owner/mode, and exposes it read-only inside the sandbox.
updated_sandbox_docker["binds"] = [exec_control_bind]
updated_sandbox_docker["dangerouslyAllowExternalBindSources"] = True
search = updated_web.get("search", {})
searxng = updated.get("plugins", {}).get("entries", {}).get("searxng", {})
search_url = searxng.get("config", {}).get("webSearch", {}).get("baseUrl")
if (not isinstance(search, dict) or search.get("provider") != "searxng"
        or searxng.get("enabled") is not True
        or not isinstance(search_url, str)
        or not re.fullmatch(r"http://127\.0\.0\.1:[1-9][0-9]{0,4}", search_url)
        or int(search_url.rsplit(":", 1)[1]) > 65535):
    raise SystemExit("ODS Pixel private web search is not bound to local SearXNG")
updated_provider["timeoutSeconds"] = 1800
updated_defaults["timeoutSeconds"] = 1800
updated_defaults["bootstrapMaxChars"] = 32000
updated_defaults["bootstrapTotalMaxChars"] = 96000
updated_defaults["contextInjection"] = "continuation-skip"
context_window = updated_model.get("contextWindow")
model_max_tokens = updated_model.get("maxTokens")
if (type(context_window) is not int or type(model_max_tokens) is not int
        or context_window < 4096 or not 1 <= model_max_tokens <= context_window):
    raise SystemExit("OpenClaw model limits are outside the ODS Pixel runtime contract")
# OpenClaw otherwise reserves 16K tokens even for a small local context. Bind
# compaction headroom to the real model output ceiling so the fixed Pixel
# system/tool prompt remains usable, and disable the larger embedded-run floor.
updated_compaction["reserveTokens"] = model_max_tokens
updated_compaction["reserveTokensFloor"] = 0
# The legacy OpenAI-completions transport in OpenClaw 2026.6.33 coerces the literal
# reasoning effort "off" with Boolean("off"), which wrongly sends
# chat_template_kwargs.enable_thinking=true. With the llama.cpp Qwen template
# that can spend the complete output budget in hidden reasoning after a tool
# call and leave no user-visible answer. When ODS reasoning is disabled, keep
# the model non-reasoning and omit the Qwen compatibility knob so the llama.cpp
# independently pinned no-think default remains authoritative. When the owner
# explicitly enables reasoning, advertise the capability and use a real
# non-off effort so both affected and corrected OpenClaw transports agree.
model_reasoning = updated_model.get("reasoning", False)
if type(model_reasoning) is not bool:
    raise SystemExit("OpenClaw model reasoning configuration must be boolean")
updated_model["reasoning"] = model_reasoning
model_label = "{} {}".format(updated_model.get("id", ""), updated_model.get("name", "")).casefold()
if "qwen" in model_label and model_reasoning:
    model_compat = updated_model.setdefault("compat", {})
    if not isinstance(model_compat, dict):
        raise SystemExit("OpenClaw Qwen compatibility configuration must be an object")
    model_compat["thinkingFormat"] = "qwen-chat-template"
    updated_agent["thinkingDefault"] = "low"
else:
    updated_model.pop("compat", None)
    updated_agent.pop("thinkingDefault", None)
# A CPU-only model call can emit no progress while evaluating a long prompt.
# Let the 30-minute provider own its terminal timeout, then retain one minute
# for the OpenClaw stalled-session recovery before the 32-minute host ingress.
updated_diagnostics["stuckSessionAbortMs"] = 1860000
write_lock["maxHoldMs"] = 1920000
write_lock["staleMs"] = 3600000
updated_tools["loopDetection"] = {
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
# Search stays private through loopback-only SearXNG. Page retrieval uses
# OpenClaw public-network SSRF guard with deliberately tighter ODS bounds;
# private/link-local targets and trusted environment proxies remain disabled.
updated_fetch.update({
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
})
updated_agent_tools["deny"] = [
    item for item in updated_agent_deny
    if item not in {
        "web_search", "web_fetch", "pixel_ods_status", "pixel_ods_apps_list",
        "pixel_ods_web_extract", "pixel_web_extract"
    }
]
updated_also_allow = [item for item in updated_also_allow if item != "pixel_web_extract"]
updated_sandbox_allow = [item for item in updated_sandbox_allow if item != "pixel_web_extract"]
for extension_tool in ("pixel_ods_status", "pixel_ods_apps_list", "pixel_ods_web_extract"):
    if extension_tool not in updated_also_allow:
        updated_also_allow.append(extension_tool)
for permitted_tool in (
    "web_search", "web_fetch", "pixel_ods_status", "pixel_ods_apps_list", "pixel_ods_web_extract"
):
    if permitted_tool not in updated_sandbox_allow:
        updated_sandbox_allow.append(permitted_tool)
updated_tools["alsoAllow"] = sorted(set(updated_also_allow))
updated_sandbox_tools["allow"] = sorted(set(updated_sandbox_allow))
if updated == value:
    print("unchanged")
    raise SystemExit(0)

fd, temporary = tempfile.mkstemp(prefix=".ods-pixel-runtime-budget.", dir=path.parent)
try:
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(updated, handle, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    print(temporary)
except BaseException:
    if os.path.exists(temporary):
        os.unlink(temporary)
    raise
PY
)" || return 1
    if [[ "$staged" == unchanged ]]; then
        printf '%s\n' unchanged
        return 0
    fi
    [[ "$staged" == "${config%/*}/.ods-pixel-runtime-budget."* && -f "$staged" && ! -L "$staged" ]] || return 1
    if ! ods_pixel_run_as_owner "$owner" "$home" env OPENCLAW_CONFIG_PATH="$staged" \
        "$openclaw_bin" config validate >/dev/null 2>&1; then
        ods_pixel_run_as_owner "$owner" "$home" rm -f -- "$staged"
        return 1
    fi
    if ! _ods_pixel_atomic_replace_managed_file "$owner" "$home" "$staged" "$config"; then
        ods_pixel_run_as_owner "$owner" "$home" rm -f -- "$staged"
        return 1
    fi
    ods_pixel_run_as_owner "$owner" "$home" rm -f -- "$staged" || return 1
    printf '%s\n' changed
}

_ods_pixel_restart_gateway_and_verify() {
    local owner="$1" home="$2" pixel_root="$3" attempt ready=false previous_pid current_pid
    previous_pid="$(systemctl show openclaw-gateway.service -p MainPID --value 2>/dev/null || true)"
    if ods_sudo_available; then
        # Writing the final ODS runtime overlay can make OpenClaw begin its own
        # supervised config restart before this helper samples MainPID. A
        # transient MainPID=0 is safe on the privileged systemd path because
        # `systemctl restart` establishes the desired service state directly.
        # Keep the stricter live-PID proof below for the unprivileged signal
        # fallback, where ODS must prove exactly which owner process it kills.
        ods_sudo systemctl restart openclaw-gateway.service || return 1
    else
        # The ODS host agent runs as the same unprivileged install owner. Its
        # non-interactive sudo credential may expire long after installation,
        # so allow one narrow restart path without granting general sudo: the
        # verified system unit must run as this owner with Restart=always, and
        # /proc must prove the current MainPID has that owner's UID. SIGTERM is
        # then enough for systemd to replace the process under the same unit.
        local unit_user restart_policy owner_uid process_uid
        [[ "$previous_pid" =~ ^[1-9][0-9]*$ ]] || return 1
        unit_user="$(systemctl show openclaw-gateway.service -p User --value 2>/dev/null || true)"
        restart_policy="$(systemctl show openclaw-gateway.service -p Restart --value 2>/dev/null || true)"
        owner_uid="$(id -u "$owner" 2>/dev/null || true)"
        process_uid="$(awk '/^Uid:/ { print $2; exit }' "/proc/${previous_pid}/status" 2>/dev/null || true)"
        [[ "$(id -un)" == "$owner" && "$unit_user" == "$owner" \
            && "$restart_policy" == "always" && "$owner_uid" =~ ^[0-9]+$ \
            && "$process_uid" == "$owner_uid" ]] || return 1
        current_pid="$(systemctl show openclaw-gateway.service -p MainPID --value 2>/dev/null || true)"
        [[ "$current_pid" == "$previous_pid" ]] || return 1
        kill -TERM "$previous_pid" || return 1
    fi
    current_pid=""
    for attempt in {1..60}; do
        current_pid="$(systemctl show openclaw-gateway.service -p MainPID --value 2>/dev/null || true)"
        if [[ "$current_pid" =~ ^[1-9][0-9]*$ \
            && ( ! "$previous_pid" =~ ^[1-9][0-9]*$ || "$current_pid" != "$previous_pid" ) ]] \
            && systemctl is-active --quiet openclaw-gateway.service; then
            break
        fi
        sleep 1
    done
    [[ "$current_pid" =~ ^[1-9][0-9]*$ \
        && ( ! "$previous_pid" =~ ^[1-9][0-9]*$ || "$current_pid" != "$previous_pid" ) ]] || return 1
    for attempt in {1..60}; do
        if curl --fail --silent --show-error --max-time 5 http://127.0.0.1:18789/health 2>/dev/null \
            | jq -e '.ok == true and .status == "live"' >/dev/null 2>&1; then
            ready=true
            break
        fi
        (( attempt < 60 )) && sleep 2
    done
    [[ "$ready" == true ]] || return 1
    ods_pixel_run_as_owner "$owner" "$home" "$pixel_root/pixel" verify
}

_ods_pixel_restore_model_reconciliation() {
    local owner="$1" home="$2" pixel_root="$3" answers="$4" backup="$5"
    local old_contract openclaw_bin
    openclaw_bin="$(_ods_pixel_openclaw_bin "$owner" "$home")" || return 1
    _ods_pixel_atomic_replace_managed_file "$owner" "$home" "$backup/openclaw.json" "$home/.openclaw/openclaw.json" || return 1
    _ods_pixel_atomic_replace_managed_file "$owner" "$home" "$backup/rollback-onboarding.json" "$answers" || return 1
    _ods_pixel_atomic_replace_managed_file "$owner" "$home" "$backup/pixel-managed.json" "$home/.config/ods/pixel-managed.json" || return 1
    if ! ods_pixel_run_as_owner "$owner" "$home" "$pixel_root/pixel" configure --answers "$answers" --force \
        || ! ods_pixel_run_as_owner "$owner" "$home" "$pixel_root/pixel" plan \
        || ! _ods_pixel_recreate_agent_sandbox "$owner" "$home" "$openclaw_bin" \
        || ! _ods_pixel_restart_gateway_and_verify "$owner" "$home" "$pixel_root"; then
        _ods_pixel_atomic_replace_managed_file "$owner" "$home" "$backup/runtime-attestation.json" \
            "$home/.local/share/pixel/runtime-attestation.json" || true
        return 1
    fi
    old_contract="$(_ods_pixel_contract_sha256 "$owner" "$home" "$answers")" || return 1
    _ods_pixel_mark_ready "$owner" "$home" "$old_contract" "$pixel_root"
}

ods_pixel_reconcile_promoted_model() {
    local owner="$1" home="$2" promoted_model="$3" final_state="${4:-ready}"
    local promoted_context="${5:-}" promoted_max_tokens="${6:-}" promoted_reasoning="${7:-}"
    local source_ref source_root pixel_root answers candidate backup contract_sha256 openclaw_bin failed=false
    local failure_phase="unknown"
    [[ "$final_state" == ready || "$final_state" == installing ]] || return 1
    source_ref="$(_ods_pixel_managed_source_ref "$owner" "$home")" || return 1
    local PIXEL_SOURCE_REF="$source_ref"
    local PIXEL_SOURCE_URL="${PIXEL_SOURCE_URL:-https://github.com/Osmantic/Pixel.git}"
    source_root="${INSTALL_DIR:?}/data/pixel/source-$source_ref"
    pixel_root="$(_ods_pixel_source_checkout "$owner" "$home" "$source_root")" || return 1
    answers="$INSTALL_DIR/data/pixel/onboarding.json"
    candidate="$pixel_root/dist/openclaw.json"
    backup="$(_ods_pixel_model_reconciliation_snapshot "$owner" "$home" "$answers")" || return 1
    openclaw_bin="$(_ods_pixel_openclaw_bin "$owner" "$home")" || return 1
    [[ "$openclaw_bin" == /* && -x "$openclaw_bin" ]] || return 1

    if ! _ods_pixel_update_onboarding_model "$owner" "$home" "$answers" "$promoted_model" \
        "$promoted_context" "$promoted_max_tokens" "$promoted_reasoning"; then
        failed=true
        failure_phase="onboarding-update"
    fi
    if [[ "$failed" == false ]] \
        && ! ods_pixel_run_as_owner "$owner" "$home" "$pixel_root/pixel" configure --answers "$answers" --force; then
        failed=true
        failure_phase="pixel-configure"
    fi
    if [[ "$failed" == false ]] \
        && ! ods_pixel_run_as_owner "$owner" "$home" "$pixel_root/pixel" plan; then
        failed=true
        failure_phase="pixel-plan"
    fi
    if [[ "$failed" == false ]] \
        && ! _ods_pixel_apply_runtime_budget "$owner" "$home" "$candidate" "$openclaw_bin" >/dev/null; then
        failed=true
        failure_phase="runtime-budget"
    fi
    if [[ "$failed" == false ]] \
        && ! _ods_pixel_candidate_is_managed_runtime_update "$owner" "$home" "$candidate" "$answers"; then
        failed=true
        failure_phase="managed-update-validation"
    fi
    if [[ "$failed" == false ]] && ! _ods_pixel_candidate_config_matches_live "$owner" "$home" "$candidate"; then
        if ! _ods_pixel_atomic_replace_managed_file "$owner" "$home" "$candidate" "$home/.openclaw/openclaw.json"; then
            failed=true
            failure_phase="config-install"
        fi
    fi
    if [[ "$failed" == false ]] \
        && ! _ods_pixel_recreate_agent_sandbox "$owner" "$home" "$openclaw_bin"; then
        failed=true
        failure_phase="sandbox-recreate"
    fi
    if [[ "$failed" == false ]] \
        && ! _ods_pixel_restart_gateway_and_verify "$owner" "$home" "$pixel_root"; then
        failed=true
        failure_phase="gateway-restart-verify"
    fi
    if [[ "$failed" == false ]]; then
        if ! contract_sha256="$(_ods_pixel_contract_sha256 "$owner" "$home" "$answers")"; then
            failed=true
            failure_phase="contract-hash"
        fi
    fi
    if [[ "$failed" == false ]]; then
        if [[ "$final_state" == ready ]]; then
            if ! _ods_pixel_mark_ready "$owner" "$home" "$contract_sha256" "$pixel_root"; then
                failed=true
                failure_phase="ready-marker"
            fi
        else
            if ! _ods_pixel_mark_verified_installing "$owner" "$home" "$contract_sha256" "$pixel_root"; then
                failed=true
                failure_phase="installing-marker"
            fi
        fi
    fi
    if [[ "$failed" == false ]]; then
        printf '%s\n' "Pixel model route reconciled to $promoted_model"
        return 0
    fi

    printf 'warning: Pixel model reconciliation failed during phase=%s; restoring the previous verified route\n' \
        "$failure_phase" >&2
    if _ods_pixel_restore_model_reconciliation "$owner" "$home" "$pixel_root" "$answers" "$backup"; then
        printf '%s\n' 'warning: previous Pixel model route restored and verified; rollback=verified' >&2
    else
        printf '%s\n' "error: Pixel model reconciliation and verified rollback both failed; rollback=failed evidence=$backup" >&2
    fi
    return 1
}

_ods_pixel_mark_installing() {
    local owner="$1" home="$2" marker
    marker="$home/.config/ods/pixel-managed.json"
    ods_pixel_run_as_owner "$owner" "$home" python3 - "$marker" "${INSTALL_DIR:?}" "${PIXEL_SOURCE_REF:?}" <<'PY'
import json, os, pathlib, stat, sys, tempfile

path = pathlib.Path(sys.argv[1])
info = path.lstat()
if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1
        or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 65536):
    raise SystemExit("invalid Pixel management marker")
value = json.loads(path.read_text(encoding="utf-8"))
if (value.get("schema_version") != 2 or value.get("manager") != "ods"
        or value.get("initial_active_state") != "absent" or value.get("install_dir") != sys.argv[2]):
    raise SystemExit("Pixel management marker does not match this ODS install")
value["state"] = "installing"
if all(key in value for key in (
        "active_release_version", "release_identity_sha256", "install_manifest_sha256",
        "sandbox_image", "sandbox_image_id")):
    value["requested_source_ref"] = sys.argv[3]
else:
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
    local source_timeout="${ODS_PIXEL_SOURCE_TIMEOUT_SECONDS:-180}"
    [[ "$source_root" == /* && "$source_root" != / && ! -L "$source_root" ]] || return 1
    [[ "$source_timeout" =~ ^[0-9]+$ && "$source_timeout" -ge 1 && "$source_timeout" -le 900 ]] || return 1

    if [[ ! -e "$source_root" ]]; then
        local parent="${source_root%/*}" stage checkout
        ods_pixel_run_as_owner "$owner" "$home" mkdir -p -- "$parent"
        stage="$(ods_pixel_run_as_owner "$owner" "$home" mktemp -d "$parent/.pixel-source.XXXXXX")" || return 1
        checkout="$stage/checkout"
        if [[ "$source" == https://github.com/Osmantic/Pixel.git ]]; then
            if ! ods_pixel_run_as_owner "$owner" "$home" timeout "${source_timeout}s" \
                env GIT_TERMINAL_PROMPT=0 git -c credential.interactive=never \
                clone --filter=blob:none --no-checkout -- "$source" "$checkout" >/dev/null; then
                ods_pixel_run_as_owner "$owner" "$home" rm -rf -- "$stage"
                printf '%s\n' 'error: Pixel source clone failed or timed out; configure authorized Git access or use the documented local checkout' >&2
                return 1
            fi
        else
            if ! ods_pixel_run_as_owner "$owner" "$home" timeout "${source_timeout}s" \
                env GIT_TERMINAL_PROMPT=0 git -c credential.interactive=never \
                clone --no-local --no-checkout -- "$source" "$checkout" >/dev/null; then
                ods_pixel_run_as_owner "$owner" "$home" rm -rf -- "$stage"
                return 1
            fi
        fi
        if ! ods_pixel_run_as_owner "$owner" "$home" timeout 60s \
            env GIT_TERMINAL_PROMPT=0 git -C "$checkout" -c advice.detachedHead=false checkout --detach "$ref" >/dev/null \
            || ! ods_pixel_run_as_owner "$owner" "$home" mv -T -- "$checkout" "$source_root"; then
            ods_pixel_run_as_owner "$owner" "$home" rm -rf -- "$stage"
            return 1
        fi
        ods_pixel_run_as_owner "$owner" "$home" rmdir -- "$stage" || return 1
    fi

    # Re-check the destination after the atomic move. The initial guard runs
    # before cloning; this closes the narrow replacement window between mv and
    # the exact-commit/clean-tree verification below.
    [[ ! -L "$source_root" && -d "$source_root/.git" && ! -L "$source_root/.git" ]] || return 1
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
    if [[ "$context" =~ ^[0-9]+$ && "$context" -ge 16384 ]]; then
        :
    else
        ai_bad "Pixel requires a model context of at least 16384 tokens."
        return 1
    fi
    (( context < 32768 )) && max_tokens="$((context / 8))"
    # This field controls the active OpenClaw reasoning path, not merely the
    # model family's theoretical capability. Keep the default no-think setting
    # false even for reasoning-capable models; an explicit operator setting
    # enables it and is reconciled transactionally on model swaps.
    if [[ ! "${LLAMA_REASONING:-off}" =~ ^(off|none|false|0)$ ]]; then
        reasoning=true
    fi

    ods_pixel_run_as_owner "$owner" "$home" install -d -m 0700 -- "${answers%/*}" || return 1
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
        "tools": ["pixel_ods_status", "pixel_ods_apps_list", "pixel_ods_web_extract"],
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
    local ods_version="${VERSION:-2.6.0}"
    [[ "$ods_version" =~ ^[0-9]+(\.[0-9]+){1,3}([-+][A-Za-z0-9.-]+)?$ ]] || return 1
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
PIXEL_ODS_VERSION=$ods_version
EOF
    chmod 0640 "$stage/pixel-agent.env"
    ods_sudo install -d -m 0755 /usr/local/libexec /etc/ods
    ods_sudo install -o root -g root -m 0755 "$plugin_root/host/pixel_ingress.mjs" /usr/local/libexec/ods-pixel-ingress.mjs
    ods_sudo install -o root -g ods-pixel -m 0640 "$stage/pixel-agent.env" /etc/ods/pixel-agent.env
    ods_sudo install -o root -g root -m 0644 "$stage/pixel-ingress.service" /etc/systemd/system/pixel-ingress.service
    rm -f -- "$stage/pixel-agent.env" "$stage/pixel-ingress.service"
    rmdir -- "$stage"
    ods_sudo systemctl daemon-reload || return 1
    ods_sudo systemctl enable openclaw-gateway.service pixel-ingress.service || return 1
    ods_sudo systemctl start openclaw-gateway.service || return 1
    # `enable --now` does not refresh an already-running ingress after its
    # reviewed program or environment changes. Restart only the ingress here;
    # the Pixel gateway was already verified above and need not be disturbed.
    ods_sudo systemctl restart pixel-ingress.service || return 1
    ods_sudo systemctl is-active --quiet openclaw-gateway.service pixel-ingress.service
}

_ods_pixel_wait_ingress() {
    local owner="$1" home="$2" attempts="${3:-60}" delay="${4:-1}" response
    [[ "$attempts" =~ ^[0-9]+$ && "$attempts" -ge 1 && "$attempts" -le 300 ]] || return 1
    [[ "$delay" =~ ^[0-9]+$ && "$delay" -le 5 ]] || return 1
    local attempt
    for ((attempt = 1; attempt <= attempts; attempt++)); do
        if response="$(ods_pixel_run_as_owner "$owner" "$home" curl --fail --silent --show-error --max-time 10 \
            --unix-socket /run/ods-pixel/pixel-ingress.sock http://localhost/health 2>/dev/null)" \
            && jq -e '.status == "ok"' <<<"$response" >/dev/null 2>&1; then
            return 0
        fi
        if (( attempt < attempts && delay > 0 )); then
            sleep "$delay"
        fi
    done
    return 1
}

ods_pixel_install_default_agent() {
    [[ "${ENABLE_PIXEL_RUNTIME:-false}" == true ]] || return 0
    local owner home source_root pixel_root plugin_root answers openclaw_bin plugin_digest contract_sha256 runtime_budget_status
    local candidate_runtime_status reuse_active=false same_verified_source=false same_source_resume=false
    owner="${PIXEL_SERVICE_USER:-$(ods_pixel_install_owner)}" || return 1
    home="$(ods_pixel_owner_home "$owner")" || return 1
    _ods_pixel_assert_managed_state "$owner" "$home" || return 1
    source_root="${INSTALL_DIR:?}/data/pixel/source-${PIXEL_SOURCE_REF:?}"
    pixel_root="$(_ods_pixel_source_checkout "$owner" "$home" "$source_root")" || {
        ai_bad "Pixel source checkout is absent, changed, or not at the configured exact commit."
        return 1
    }
    plugin_root="${INSTALL_DIR:?}/extensions/services/pixel-agent"
    [[ -f "$plugin_root/plugin/openclaw.plugin.json" \
        && -f "$plugin_root/host/pixel_ingress.mjs" \
        && -f "$plugin_root/host/cancellable-exec.sh" ]] || return 1
    if ! _ods_pixel_secure_plugin_tree "$owner" "$home" "$plugin_root/plugin"; then
        ai_bad "The ODS Pixel plugin path is not a safe owner-controlled code tree."
        return 1
    fi
    if ! _ods_pixel_install_exec_control "$owner" "$home" "$plugin_root/host/cancellable-exec.sh"; then
        ai_bad "Could not install Pixel's owner-private cancellable execution control."
        return 1
    fi

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
    openclaw_bin="$(_ods_pixel_openclaw_bin "$owner" "$home")"
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
    if _ods_pixel_verified_source_matches "$owner" "$home"; then
        same_verified_source=true
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
        if ! ods_pixel_run_as_owner "$owner" "$home" "$pixel_root/pixel" configure --answers "$answers" --force >>"$LOG_FILE" 2>&1 \
            || ! ods_pixel_run_as_owner "$owner" "$home" "$pixel_root/pixel" plan >>"$LOG_FILE" 2>&1; then
            ai_bad "Pixel configure or plan failed. See $LOG_FILE for the exact Pixel error."
            return 1
        fi
        if [[ "$same_verified_source" == true ]]; then
            if _ods_pixel_candidate_config_matches_live "$owner" "$home" "$pixel_root/dist/openclaw.json"; then
                same_source_resume=true
                ai "The exact Pixel release and runtime configuration are unchanged; refreshing the verified ODS extension without reapplying the release..."
            else
                # A run from an older installer may have atomically written the
                # deterministic ODS overlay before it could bind the updated
                # marker. Recreate that overlay on the reviewed candidate and
                # require whole-document equality before accepting this narrow
                # recovery path. Unrelated live changes still fail closed into
                # the transactional model-reconciliation path below.
                candidate_runtime_status="$(_ods_pixel_apply_runtime_budget "$owner" "$home" \
                    "$pixel_root/dist/openclaw.json" "$openclaw_bin")" || {
                    ai_bad "Could not validate the exact-source Pixel runtime candidate for safe recovery."
                    return 1
                }
                case "$candidate_runtime_status" in
                    changed|unchanged) ;;
                    *)
                        ai_bad "Pixel returned an invalid exact-source runtime recovery result."
                        return 1
                        ;;
                esac
                if _ods_pixel_candidate_config_matches_live "$owner" "$home" "$pixel_root/dist/openclaw.json"; then
                    same_source_resume=true
                    ai "The exact Pixel release and deterministic ODS runtime policy are already active; repairing the interrupted ownership checkpoint..."
                fi
            fi
            if [[ "$same_source_resume" == true ]]; then
                if ! ods_sudo systemctl restart openclaw-gateway.service \
                    || ! _ods_pixel_wait_http "Pixel gateway" "http://127.0.0.1:18789/health" 60 '.ok == true and .status == "live"' \
                    || ! ods_pixel_run_as_owner "$owner" "$home" "$pixel_root/pixel" verify >>"$LOG_FILE" 2>&1; then
                    ai_bad "The ODS-managed Pixel extension refresh failed verification. See $LOG_FILE."
                    return 1
                fi
            else
                ai "The exact Pixel release is active with an older ODS route; reconciling the reviewed model/runtime policy..."
                if ! ods_pixel_reconcile_promoted_model "$owner" "$home" "${LLM_MODEL:-default}" installing >>"$LOG_FILE" 2>&1; then
                    ai_bad "The ODS-managed Pixel model route could not be reconciled safely. See $LOG_FILE."
                    return 1
                fi
            fi
        elif ! {
            ods_pixel_run_as_owner "$owner" "$home" "$pixel_root/pixel" apply --confirm &&
            ods_pixel_run_as_owner "$owner" "$home" "$pixel_root/pixel" verify
        } >>"$LOG_FILE" 2>&1; then
            ai_bad "Pixel apply or verify failed. See $LOG_FILE for the exact Pixel error."
            return 1
        fi
    fi
    # Record the verified Pixel release before applying the ODS-owned runtime
    # overlay. If power is lost between the atomic config update and gateway
    # verification, the next installer run can safely enter the exact-source
    # reconciliation path instead of attempting to reapply an active release.
    if ! _ods_pixel_mark_verified_installing "$owner" "$home" "$contract_sha256" "$pixel_root"; then
        ai_bad "Could not bind the verified Pixel release before local-runtime configuration."
        return 1
    fi
    runtime_budget_status="$(_ods_pixel_apply_runtime_budget "$owner" "$home" \
        "$home/.openclaw/openclaw.json" "$openclaw_bin")" || {
        ai_bad "Could not validate and apply Pixel's ODS local-runtime budget."
        return 1
    }
    case "$runtime_budget_status" in
        changed) ai "Applying Pixel's bounded ODS local-runtime budget..." ;;
        unchanged) ;;
        *)
            ai_bad "Pixel returned an invalid ODS local-runtime budget result."
            return 1
            ;;
    esac
    # The runtime overlay above replaces the live configuration atomically.
    # Bind that exact canonical file before any fallible registry or service
    # operation. If either later step is interrupted, the next installer run
    # can prove the managed contract and resume without misclassifying ODS's
    # own runtime policy as unmanaged drift.
    if ! _ods_pixel_mark_verified_installing "$owner" "$home" "$contract_sha256" "$pixel_root"; then
        ai_bad "Could not bind the verified Pixel ODS local-runtime configuration."
        return 1
    fi
    # OpenClaw persists plugin descriptors separately from its live config.
    # Rebuild that registry after any reviewed extension/config update, then
    # restart once so the gateway loads both the exact descriptor contract and
    # the final ODS runtime policy. A plain service restart can otherwise keep
    # stale tool descriptors across same-release extension refreshes.
    if ! _ods_pixel_refresh_plugin_registry "$owner" "$home" "$openclaw_bin" "$plugin_root/plugin" \
        >>"$LOG_FILE" 2>&1; then
        ai_bad "Pixel could not refresh the exact ODS plugin registry. See $LOG_FILE."
        return 1
    fi
    if ! _ods_pixel_recreate_agent_sandbox "$owner" "$home" "$openclaw_bin" \
        >>"$LOG_FILE" 2>&1; then
        ai_bad "Pixel could not recreate its agent sandbox for the reviewed ODS runtime. See $LOG_FILE."
        return 1
    fi
    if ! _ods_pixel_restart_gateway_and_verify "$owner" "$home" "$pixel_root" \
        >>"$LOG_FILE" 2>&1; then
        ai_bad "Pixel could not restart and verify its gateway after the ODS runtime update. See $LOG_FILE."
        return 1
    fi
    # Reconfirm the exact verified contract and canonical live config after the
    # gateway has loaded them while the marker remains non-ready. If ingress
    # setup is interrupted, a rerun can verify and reuse this same release.
    if ! _ods_pixel_mark_verified_installing "$owner" "$home" "$contract_sha256" "$pixel_root"; then
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
    if ! _ods_pixel_wait_ingress "$owner" "$home"; then
        ai_bad "Pixel ingress did not pass its authenticated loopback health check."
        return 1
    fi
    if ! _ods_pixel_verify_plugin_loaded "$owner" "$home" "$openclaw_bin" "$plugin_root/plugin"; then
        ai_bad "The reviewed ODS Pixel plugin and exact tool contract are not loaded by the active gateway."
        return 1
    fi
    if ! _ods_pixel_mark_ready "$owner" "$home" "$contract_sha256" "$pixel_root"; then
        ai_bad "Could not record the verified Pixel runtime as ready."
        return 1
    fi
    ai_ok "Pixel is installed, verified, and ready on the private ODS ingress"
}
