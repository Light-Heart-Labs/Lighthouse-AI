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
    if ! python3 - \
        "$marker" "$install_dir" "$owner_home" "$(id -u)" "$root_uid" \
        "$gateway_unit" "$ingress_unit" "$ingress_env" "$ingress_program" "$source_program" \
        "$openclaw_config" "$gateway_env" "$onboarding" <<'PY'
import json
import os
import pathlib
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
    or value.get("schema_version") != 1
    or value.get("manager") != "ods"
    or value.get("install_dir") != str(install_dir)
    or value.get("state") not in {"installing", "ready"}
):
    raise SystemExit("Pixel management marker does not bind this ODS install")
source_ref = value.get("pixel_source_ref")
if not isinstance(source_ref, str) or len(source_ref) != 40 or any(c not in "0123456789abcdef" for c in source_ref):
    raise SystemExit("Pixel management marker has an invalid source binding")

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

if onboarding.exists():
    answers = json.loads(onboarding.read_text(encoding="utf-8"))
    extensions = answers.get("gatewayExtensions") if isinstance(answers, dict) else None
    expected_plugin = str(install_dir / "extensions/services/pixel-agent/plugin")
    if not isinstance(extensions, list) or not any(
        isinstance(item, dict) and item.get("id") == "pixel-ods" and item.get("path") == expected_plugin
        for item in extensions
    ):
        raise SystemExit("Pixel onboarding is not bound to this ODS install")

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
PY
    then
        log_error "ODS-managed Pixel validation failed; leaving every Pixel artifact untouched"
        return 1
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
}
