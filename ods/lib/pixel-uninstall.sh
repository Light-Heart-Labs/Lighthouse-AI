#!/usr/bin/env bash
# Remove only a Pixel deployment whose private management marker binds it to
# the ODS install being uninstalled. Importing this file has no side effects.

ods_pixel_uninstall_managed() {
    local install_dir="$1" owner_home="$2"
    local marker="$owner_home/.config/ods/pixel-managed.json"
    local systemd_dir="${ODS_PIXEL_UNINSTALL_SYSTEMD_DIR:-/etc/systemd/system}"
    local etc_dir="${ODS_PIXEL_UNINSTALL_ETC_DIR:-/etc/ods}"
    local libexec_dir="${ODS_PIXEL_UNINSTALL_LIBEXEC_DIR:-/usr/local/libexec}"
    local root_uid="${ODS_PIXEL_UNINSTALL_ROOT_UID:-0}"
    local gateway_unit="$systemd_dir/openclaw-gateway.service"
    local ingress_unit="$systemd_dir/pixel-ingress.service"
    local ingress_env="$etc_dir/pixel-agent.env"
    local ingress_program="$libexec_dir/ods-pixel-ingress.mjs"
    local source_program="$install_dir/extensions/services/pixel-agent/host/pixel_ingress.mjs"
    local openclaw_config="$owner_home/.openclaw/openclaw.json"
    local gateway_env="$owner_home/.config/pixel-agent/gateway.env"
    local onboarding="$owner_home/.config/pixel-deployment/onboarding.json"
    local pixel_install="$owner_home/.local/share/pixel"
    local current="$pixel_install/current"
    local runtime_attestation="$pixel_install/runtime-attestation.json"
    local staged_current="$pixel_install/.ods-uninstall-current"
    local staged_attestation="$pixel_install/.ods-uninstall-runtime-attestation"
    local deployment_lock="$pixel_install/.deployment.lock"
    local cleanup_plan cleanup_state release_version sandbox_image sandbox_image_id release_path
    local release_identity_sha256 install_manifest_sha256
    local pixel_lock_fd="" owner_uid
    local root_artifacts_present=false

    [[ "$install_dir" == /* && "$install_dir" != / && -d "$install_dir" && ! -L "$install_dir" ]] || {
        log_error "Refusing Pixel cleanup for an invalid ODS install directory"
        return 1
    }
    [[ "$owner_home" == /* && "$owner_home" != / && -d "$owner_home" && ! -L "$owner_home" ]] || {
        log_error "Refusing Pixel cleanup for an invalid owner home"
        return 1
    }
    [[ "$root_uid" =~ ^[0-9]+$ ]] || return 1

    if [[ ! -e "$marker" && ! -L "$marker" ]]; then
        return 0
    fi

    # Validate every deletion target before stopping services or removing any
    # file. The marker must be private, owner-controlled, and bind this exact
    # install. Root artifacts must still match the ODS/Pixel contract; drift
    # fails closed instead of deleting an ambient or operator-modified service.
    owner_uid="$(id -u)"
    if ! cleanup_plan="$(python3 - \
        "$marker" "$install_dir" "$owner_home" "$(id -u)" "$root_uid" \
        "$gateway_unit" "$ingress_unit" "$ingress_env" "$ingress_program" "$source_program" \
        "$openclaw_config" "$gateway_env" "$onboarding" \
        "$current" "$runtime_attestation" "$staged_current" "$staged_attestation" "$deployment_lock" <<'PY'
import hashlib
import json
import os
import pathlib
import re
import stat
import sys

(
    marker_raw,
    install_raw,
    home_raw,
    owner_uid_raw,
    root_uid_raw,
    gateway_unit_raw,
    ingress_unit_raw,
    ingress_env_raw,
    ingress_program_raw,
    source_program_raw,
    openclaw_config_raw,
    gateway_env_raw,
    onboarding_raw,
    current_raw,
    runtime_attestation_raw,
    staged_current_raw,
    staged_attestation_raw,
    deployment_lock_raw,
) = sys.argv[1:]

marker = pathlib.Path(marker_raw)
install_dir = pathlib.Path(install_raw)
owner_home = pathlib.Path(home_raw)
owner_uid = int(owner_uid_raw)
root_uid = int(root_uid_raw)


def regular(path: pathlib.Path, uid: int, maximum: int, private: bool = False) -> os.stat_result:
    info = path.lstat()
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_nlink != 1
        or info.st_uid != uid
        or info.st_size > maximum
        or info.st_mode & 0o022
        or (private and info.st_mode & 0o077)
    ):
        raise SystemExit(f"unsafe managed Pixel artifact: {path}")
    return info


regular(marker, owner_uid, 65536, private=True)
value = json.loads(marker.read_text(encoding="utf-8"))
if (
    not isinstance(value, dict)
    or value.get("schema_version") not in {1, 2}
    or value.get("manager") != "ods"
    or value.get("install_dir") != str(install_dir)
    or value.get("state") not in {"installing", "ready"}
):
    raise SystemExit("Pixel management marker does not bind this ODS install")
source_ref = value.get("pixel_source_ref")
if not isinstance(source_ref, str) or len(source_ref) != 40 or any(c not in "0123456789abcdef" for c in source_ref):
    raise SystemExit("Pixel management marker has an invalid source binding")

current = pathlib.Path(current_raw)
runtime_attestation = pathlib.Path(runtime_attestation_raw)
staged_current = pathlib.Path(staged_current_raw)
staged_attestation = pathlib.Path(staged_attestation_raw)
deployment_lock = pathlib.Path(deployment_lock_raw)
current_present = current.exists() or current.is_symlink()
attestation_present = runtime_attestation.exists() or runtime_attestation.is_symlink()
staged_current_present = staged_current.exists() or staged_current.is_symlink()
staged_attestation_present = staged_attestation.exists() or staged_attestation.is_symlink()
if current_present and not current.is_symlink():
    raise SystemExit("Pixel current active-release object is not a symlink")
if staged_current_present and not staged_current.is_symlink():
    raise SystemExit("Pixel staged active-release object is not a symlink")
if not any((current_present, attestation_present, staged_current_present, staged_attestation_present)):
    cleanup = ("none", "", "", "", "", "", "")
else:
    if ((int(current_present) + int(staged_current_present) != 1)
            or (int(attestation_present) + int(staged_attestation_present) != 1)):
        raise SystemExit("Pixel active-release state is partial, duplicated, or has an unsafe type")
    if current_present and attestation_present:
        cleanup = ("active", None, None, None, None, None, None)
    elif current_present and staged_attestation_present:
        cleanup = ("staging-attestation", None, None, None, None, None, None)
    elif staged_current_present and attestation_present:
        cleanup = ("staging-link", None, None, None, None, None, None)
    else:
        cleanup = ("staged", None, None, None, None, None, None)

if cleanup[0] != "none":
    if value.get("schema_version") != 2 or value.get("initial_active_state") != "absent":
        raise SystemExit("Pixel active state lacks an ODS pre-install absence proof")
    link = current if cleanup[0] in {"active", "staging-attestation"} else staged_current
    receipt = runtime_attestation if cleanup[0] in {"active", "staging-link"} else staged_attestation
    link_info = link.lstat()
    if not stat.S_ISLNK(link_info.st_mode) or link_info.st_uid != owner_uid:
        raise SystemExit("unsafe ODS-managed Pixel active-release link")
    release = link.resolve(strict=True)
    releases_root = pathlib.Path(home_raw) / ".local/share/pixel/releases"
    releases_info = releases_root.lstat()
    release_info = release.lstat()
    if (not stat.S_ISDIR(releases_info.st_mode) or stat.S_ISLNK(releases_info.st_mode)
            or releases_info.st_uid != owner_uid or releases_info.st_mode & 0o022
            or not stat.S_ISDIR(release_info.st_mode) or stat.S_ISLNK(release_info.st_mode)
            or release_info.st_uid != owner_uid or release_info.st_mode & 0o022
            or release.parent.resolve(strict=True) != releases_root.resolve(strict=True)):
        raise SystemExit("ODS-managed Pixel release is outside its owner-controlled release root")
    identity_path = release / "release-identity.json"
    manifest_path = release / "install-manifest.sha256"
    regular(identity_path, owner_uid, 65536)
    regular(manifest_path, owner_uid, 2 * 1024 * 1024)
    regular(receipt, owner_uid, 2 * 1024 * 1024, private=True)
    regular(deployment_lock, owner_uid, 65536, private=True)
    identity_bytes = identity_path.read_bytes()
    manifest_bytes = manifest_path.read_bytes()
    attestation_bytes = receipt.read_bytes()
    identity = json.loads(identity_bytes)
    attestation = json.loads(attestation_bytes)
    version = value.get("active_release_version")
    identity_sha256 = hashlib.sha256(identity_bytes).hexdigest()
    manifest_sha256 = hashlib.sha256(manifest_bytes).hexdigest()
    if (not isinstance(version, str) or not re.fullmatch(r"[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}", version)
            or release.name != version or identity.get("pixel") != version
            or not isinstance(identity.get("source"), dict)
            or identity["source"].get("state") != "git-clean"
            or identity["source"].get("commit") != source_ref
            or value.get("release_identity_sha256") != identity_sha256
            or value.get("install_manifest_sha256") != manifest_sha256):
        raise SystemExit("ODS marker does not bind the active Pixel release identity")
    if (not isinstance(attestation, dict) or attestation.get("kind") != "pixel-runtime-attestation"
            or attestation.get("status") not in {"verified", "limited"}
            or attestation.get("pixel") != version or attestation.get("source") != identity.get("source")
            or not isinstance(attestation.get("release"), dict)
            or attestation["release"].get("sourceIdentitySha256") != identity_sha256
            or attestation["release"].get("installManifestSha256") != manifest_sha256):
        raise SystemExit("Pixel runtime attestation does not bind the ODS-managed active release")
    sandbox_image = value.get("sandbox_image")
    sandbox_image_id = value.get("sandbox_image_id")
    if (not isinstance(sandbox_image, str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,255}:[A-Za-z0-9][A-Za-z0-9._-]{0,127}", sandbox_image)
            or not isinstance(sandbox_image_id, str)
            or not re.fullmatch(r"sha256:[0-9a-f]{64}", sandbox_image_id)
            or "|" in str(release)):
        raise SystemExit("ODS marker has an invalid Pixel sandbox binding")
    cleanup = (
        cleanup[0], version, sandbox_image, sandbox_image_id, str(release),
        identity_sha256, manifest_sha256,
    )

openclaw_config = pathlib.Path(openclaw_config_raw)
gateway_env = pathlib.Path(gateway_env_raw)
onboarding = pathlib.Path(onboarding_raw)
for path in (openclaw_config, gateway_env, onboarding):
    if path.exists() or path.is_symlink():
        regular(path, owner_uid, 2 * 1024 * 1024, private=True)

if openclaw_config.exists():
    config = json.loads(openclaw_config.read_text(encoding="utf-8"))
    if str(install_dir) not in json.dumps(config, sort_keys=True, separators=(",", ":")):
        raise SystemExit("OpenClaw configuration is not bound to this ODS install")
    if cleanup[0] != "none":
        canonical = json.dumps(config, sort_keys=True, separators=(",", ":")).encode()
        observed = hashlib.sha256(b"ods-pixel-openclaw-v1\0" + canonical).hexdigest()
        if value.get("configuration_sha256") != observed:
            raise SystemExit("OpenClaw configuration drifted from its ODS marker")
elif cleanup[0] != "none":
    raise SystemExit("ODS-managed active Pixel configuration is missing")

if onboarding.exists():
    answers = json.loads(onboarding.read_text(encoding="utf-8"))
    extensions = answers.get("gatewayExtensions") if isinstance(answers, dict) else None
    expected_plugin = str(install_dir / "extensions/services/pixel-agent/plugin")
    if not isinstance(extensions, list) or not any(
        isinstance(item, dict) and item.get("id") == "pixel-ods" and item.get("path") == expected_plugin
        for item in extensions
    ):
        raise SystemExit("Pixel onboarding is not bound to this ODS install")
    if cleanup[0] != "none":
        observed = hashlib.sha256(b"ods-pixel-contract-v1\0" + onboarding.read_bytes()).hexdigest()
        if value.get("contract_sha256") != observed:
            raise SystemExit("Pixel onboarding drifted from its ODS marker")
elif cleanup[0] != "none":
    raise SystemExit("ODS-managed active Pixel onboarding contract is missing")

gateway_unit = pathlib.Path(gateway_unit_raw)
ingress_unit = pathlib.Path(ingress_unit_raw)
ingress_env = pathlib.Path(ingress_env_raw)
ingress_program = pathlib.Path(ingress_program_raw)
source_program = pathlib.Path(source_program_raw)
for path, maximum in (
    (gateway_unit, 256 * 1024),
    (ingress_unit, 256 * 1024),
    (ingress_env, 64 * 1024),
    (ingress_program, 2 * 1024 * 1024),
):
    if path.exists() or path.is_symlink():
        regular(path, root_uid, maximum)

if gateway_unit.exists():
    text = gateway_unit.read_text(encoding="utf-8")
    if "Description=OpenClaw Gateway - Pixel" not in text or str(install_dir) not in text:
        raise SystemExit("gateway unit is not the ODS-managed Pixel unit")

if ingress_unit.exists():
    text = ingress_unit.read_text(encoding="utf-8")
    if (
        f"ExecStart=/usr/bin/env node {ingress_program}" not in text
        or f"EnvironmentFile={ingress_env}" not in text
        or "Description=Pixel Agent host ingress" not in text
    ):
        raise SystemExit("ingress unit is not the ODS-managed Pixel unit")

if ingress_env.exists():
    entries = {}
    for line in ingress_env.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        key, separator, item = line.partition("=")
        if not separator or key in entries:
            raise SystemExit("invalid Pixel ingress environment")
        entries[key] = item
    if (
        entries.get("PIXEL_INGRESS_SOCKET") != "/run/ods-pixel/pixel-ingress.sock"
        or entries.get("PIXEL_GATEWAY_TOKEN_FILE") != "/run/ods-pixel/openclaw.json"
        or entries.get("PIXEL_STATUS_FILE") != "/run/ods-pixel/ods-status.json"
    ):
        raise SystemExit("Pixel ingress environment is not ODS-managed")

if ingress_program.exists():
    if not source_program.exists() or source_program.is_symlink():
        raise SystemExit("ODS Pixel ingress source is unavailable for cleanup verification")
    if ingress_program.read_bytes() != source_program.read_bytes():
        raise SystemExit("installed Pixel ingress program drifted from this ODS install")
print("|".join(cleanup))
PY
    )"; then
        log_error "ODS-managed Pixel validation failed; leaving every Pixel artifact untouched"
        return 1
    fi
    IFS='|' read -r cleanup_state release_version sandbox_image sandbox_image_id release_path \
        release_identity_sha256 install_manifest_sha256 <<<"$cleanup_plan"
    [[ "$cleanup_state" == none || "$cleanup_state" == active || "$cleanup_state" == staged \
        || "$cleanup_state" == staging-attestation || "$cleanup_state" == staging-link ]] || {
        log_error "ODS-managed Pixel cleanup plan is invalid"
        return 1
    }

    (
    local candidate_image observed_image shared_image_present=true sandbox_container_list
    local -a sandbox_containers=()
    if [[ "$cleanup_state" != none ]]; then
        for required_command in docker flock sha256sum timeout; do
            command -v "$required_command" >/dev/null 2>&1 || {
                log_error "Cannot safely deactivate ODS-managed Pixel without $required_command"
                return 1
            }
        done
        exec {pixel_lock_fd}<>"$deployment_lock" || {
            log_error "Could not open the Pixel deployment lock safely"
            return 1
        }
        flock -n "$pixel_lock_fd" || {
            log_error "Another Pixel deployment operation is active"
            return 1
        }
        local active_link="$current"
        [[ "$cleanup_state" == staged || "$cleanup_state" == staging-link ]] && active_link="$staged_current"
        [[ "$(readlink -f -- "$active_link")" == "$release_path" \
            && "$(sha256sum "$release_path/release-identity.json" | awk '{print $1}')" == "$release_identity_sha256" \
            && "$(sha256sum "$release_path/install-manifest.sha256" | awk '{print $1}')" == "$install_manifest_sha256" ]] || {
            log_error "ODS-managed Pixel release changed while acquiring its deployment lock"
            return 1
        }
        (cd "$release_path" && timeout 60s sha256sum -c install-manifest.sha256 >/dev/null) || {
            log_error "ODS-managed Pixel release bytes no longer match their install manifest"
            return 1
        }

        candidate_image="pixel-sandbox-candidate:${release_version}-uid-${owner_uid}"
        observed_image="$(timeout 30s docker image inspect --format \
            '{{.Id}}|{{index .Config.Labels "org.osmantic.pixel.sandbox-version"}}|{{index .Config.Labels "org.osmantic.pixel.sandbox-uid"}}|{{.Config.User}}' \
            "$candidate_image" 2>/dev/null)" || {
            log_error "The ODS-managed Pixel sandbox preservation tag is missing"
            return 1
        }
        [[ "$observed_image" == "$sandbox_image_id|$release_version|$owner_uid|sandbox" ]] || {
            log_error "The ODS-managed Pixel sandbox preservation tag drifted"
            return 1
        }
        if observed_image="$(timeout 30s docker image inspect --format \
            '{{.Id}}|{{index .Config.Labels "org.osmantic.pixel.sandbox-version"}}|{{index .Config.Labels "org.osmantic.pixel.sandbox-uid"}}|{{.Config.User}}' \
            "$sandbox_image" 2>/dev/null)"; then
            [[ "$observed_image" == "$sandbox_image_id|$release_version|$owner_uid|sandbox" ]] || {
                log_error "The live Pixel sandbox image drifted"
                return 1
            }
        else
            shared_image_present=false
            [[ "$cleanup_state" == staged ]] || {
                log_error "The active ODS-managed Pixel sandbox image is missing"
                return 1
            }
        fi
        sandbox_container_list="$(timeout 30s docker ps -aq --filter 'name=^/pixel-sbx-agent-pixel-')" || {
            log_error "Could not enumerate ODS-managed Pixel sandbox containers"
            return 1
        }
        if [[ -n "$sandbox_container_list" ]]; then
            mapfile -t sandbox_containers <<<"$sandbox_container_list"
        fi
        local container container_identity
        for container in "${sandbox_containers[@]}"; do
            [[ "$container" =~ ^[0-9a-f]{12,64}$ ]] || {
                log_error "Docker returned an unsafe Pixel sandbox container ID"
                return 1
            }
            container_identity="$(timeout 30s docker inspect --format \
                '{{.Name}}|{{index .Config.Labels "openclaw.sandbox"}}|{{index .Config.Labels "openclaw.sessionKey"}}|{{.Image}}' \
                "$container" 2>/dev/null)" || return 1
            [[ "$container_identity" == /pixel-sbx-agent-pixel-*"|1|agent:pixel|$sandbox_image_id" ]] || {
                log_error "A container in Pixel's reserved sandbox namespace has unsafe identity"
                return 1
            }
        done
    fi

    log_info "Removing the ODS-managed Pixel host deployment..."
    if [[ -e "$gateway_unit" || -L "$gateway_unit" \
        || -e "$ingress_unit" || -L "$ingress_unit" \
        || -e "$ingress_env" || -L "$ingress_env" \
        || -e "$ingress_program" || -L "$ingress_program" ]]; then
        root_artifacts_present=true
        command -v sudo >/dev/null 2>&1 || {
            log_error "sudo is required to remove ODS-managed Pixel system artifacts"
            return 1
        }
    fi

    if [[ -e "$gateway_unit" || -e "$ingress_unit" ]]; then
        # Stop the ingress before the gateway it proxies to. Keep these as
        # separate calls so the shutdown order is an enforced contract rather
        # than an argument-order hint to systemctl.
        if ! timeout 30s sudo systemctl disable --now pixel-ingress.service; then
            log_error "Could not stop ODS-managed Pixel system services; no Pixel files were removed"
            return 1
        fi
        if ! timeout 30s sudo systemctl disable --now openclaw-gateway.service; then
            log_error "Could not stop ODS-managed Pixel system services; no Pixel files were removed"
            return 1
        fi
        if systemctl is-active --quiet openclaw-gateway.service \
            || systemctl is-active --quiet pixel-ingress.service; then
            log_error "ODS-managed Pixel system services are still active; no Pixel files were removed"
            return 1
        fi
    fi

    if [[ "$cleanup_state" != none ]]; then
        if (( ${#sandbox_containers[@]} > 0 )) \
            && ! timeout 30s docker rm -f -- "${sandbox_containers[@]}" >/dev/null; then
            log_error "Could not retire the ODS-managed Pixel sandbox containers"
            return 1
        fi
        case "$cleanup_state" in
            active)
                mv -T -- "$runtime_attestation" "$staged_attestation" || {
                    log_error "Could not stage the ODS-managed Pixel runtime attestation"
                    return 1
                }
                if ! mv -T -- "$current" "$staged_current"; then
                    mv -T -- "$staged_attestation" "$runtime_attestation" || true
                    log_error "Could not stage the ODS-managed Pixel active-release link"
                    return 1
                fi
                ;;
            staging-attestation)
                mv -T -- "$current" "$staged_current" || {
                    log_error "Could not resume the ODS-managed Pixel active-release staging"
                    return 1
                }
                ;;
            staging-link)
                mv -T -- "$runtime_attestation" "$staged_attestation" || {
                    log_error "Could not resume the ODS-managed Pixel runtime-attestation staging"
                    return 1
                }
                ;;
        esac
        if [[ "$shared_image_present" == true ]] \
            && ! timeout 30s docker image rm -- "$sandbox_image" >/dev/null; then
            mv -T -- "$staged_current" "$current" || true
            mv -T -- "$staged_attestation" "$runtime_attestation" || true
            log_error "Could not remove the exact ODS-managed Pixel live sandbox tag"
            return 1
        fi
        rm -f -- "$staged_current" "$staged_attestation"
        if [[ -e "$current" || -L "$current" || -e "$runtime_attestation" || -L "$runtime_attestation" \
            || -e "$staged_current" || -L "$staged_current" \
            || -e "$staged_attestation" || -L "$staged_attestation" ]] \
            || timeout 30s docker image inspect "$sandbox_image" >/dev/null 2>&1; then
            log_error "ODS-managed Pixel active-state cleanup was incomplete"
            return 1
        fi
    fi

    if [[ "$root_artifacts_present" == "true" ]]; then
        if ! sudo rm -f -- "$gateway_unit" "$ingress_unit" "$ingress_env" "$ingress_program" \
            || ! sudo systemctl daemon-reload; then
            log_error "Could not remove ODS-managed Pixel system artifacts"
            return 1
        fi
        if [[ -e "$gateway_unit" || -e "$ingress_unit" || -e "$ingress_env" || -e "$ingress_program" ]]; then
            log_error "ODS-managed Pixel system artifact cleanup was incomplete"
            return 1
        fi
    fi

    rm -f -- "$openclaw_config" "$gateway_env" "$onboarding"
    if [[ -e "$openclaw_config" || -e "$gateway_env" || -e "$onboarding" ]]; then
        log_error "ODS-managed Pixel owner artifact cleanup was incomplete"
        return 1
    fi
    rm -f -- "$marker"
    [[ ! -e "$marker" && ! -L "$marker" ]] || {
        log_error "ODS-managed Pixel marker cleanup was incomplete"
        return 1
    }
    log_ok "ODS-managed Pixel host deployment removed"
    )
}
