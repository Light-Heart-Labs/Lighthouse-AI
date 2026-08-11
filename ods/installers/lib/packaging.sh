#!/bin/bash
# ============================================================================
# ODS Installer — Packaging
# ============================================================================
# Part of: installers/lib/
# Purpose: Distro-agnostic package manager abstraction
#
# Expects: LOG_FILE, log(), warn(), error()
# Provides: detect_pkg_manager(), pkg_install(), pkg_update(), pkg_available(),
#           PKG_MANAGER, DISTRO_ID, DISTRO_ID_LIKE, HAS_BREW, BREW_BIN
#
# Modder notes:
#   Add new distro support by extending the case blocks below.
#   Distro detection reads /etc/os-release (standard on all systemd distros).
#   Homebrew (brew) is supported cross-platform: it is the package manager on
#   macOS, and on Linux it is recorded (HAS_BREW/BREW_BIN) but the native
#   manager stays authoritative so Docker/system daemons don't come from brew.
# ============================================================================

PKG_MANAGER=""
DISTRO_ID=""
DISTRO_ID_LIKE=""
# HAS_BREW / BREW_BIN are consumed by callers (installer phases) after
# detect_pkg_manager runs; shellcheck can't see those external readers.
# shellcheck disable=SC2034
HAS_BREW=""
# shellcheck disable=SC2034
BREW_BIN=""

# Use sudo only when not already root (e.g. Docker containers run as root)
_SUDO=""
if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
    if declare -f ods_sudo >/dev/null 2>&1; then
        _SUDO="ods_sudo"
    else
        _SUDO="sudo"
    fi
fi

_pkg_run() {
    if [[ -n "$_SUDO" ]]; then
        "$_SUDO" "$@"
    else
        "$@"
    fi
}

# Resolve the Homebrew binary (PATH first, then the standard Apple Silicon,
# Intel, and Linuxbrew prefixes). Caches the result in BREW_BIN. Returns
# non-zero when brew is not installed.
_brew_bin() {
    if [[ -n "$BREW_BIN" ]]; then
        printf '%s' "$BREW_BIN"
        return 0
    fi
    local candidate
    for candidate in \
        brew \
        /opt/homebrew/bin/brew \
        /usr/local/bin/brew \
        /home/linuxbrew/.linuxbrew/bin/brew \
        "$HOME/.linuxbrew/bin/brew"; do
        if command -v "$candidate" >/dev/null 2>&1 || [[ -x "$candidate" ]]; then
            BREW_BIN="$(command -v "$candidate" 2>/dev/null || printf '%s' "$candidate")"
            printf '%s' "$BREW_BIN"
            return 0
        fi
    done
    return 1
}

# Run a brew command. Homebrew refuses to run as root, so never use sudo:
# when we are root (installer under sudo), drop back to the invoking user via
# SUDO_USER. When root with no SUDO_USER, brew cannot be used — warn and fail.
_brew_run() {
    local brew
    brew="$(_brew_bin)" || { warn "brew not found; cannot run: brew $*"; return 127; }
    if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
        if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" ]]; then
            sudo -u "$SUDO_USER" -H "$brew" "$@"
        else
            warn "brew cannot run as root and no SUDO_USER to drop to; skipping: brew $*"
            return 1
        fi
    else
        "$brew" "$@"
    fi
}

_pkg_retry() {
    local max="${PKG_RETRY_ATTEMPTS:-3}"
    local delay="${PKG_RETRY_DELAY:-15}"
    local attempt=1 status=0

    while (( attempt <= max )); do
        if _pkg_run "$@"; then
            return 0
        fi
        status=$?
        if (( attempt >= max )); then
            return "$status"
        fi
        warn "Package command failed (attempt ${attempt}/${max}): $*; retrying in ${delay}s"
        sleep "$delay"
        attempt=$(( attempt + 1 ))
    done

    return "$status"
}

_pkg_prepare_pacman_keyrings() {
    command -v pacman-key >/dev/null 2>&1 || return 0

    _pkg_run pacman-key --init 2>>"$LOG_FILE" || true

    local ring
    for ring in archlinux manjaro cachyos; do
        if [[ -f "/usr/share/pacman/keyrings/${ring}.gpg" ]]; then
            _pkg_run pacman-key --populate "$ring" 2>>"$LOG_FILE" || true
        fi
    done
}

_pkg_bounded_positive_int() {
    local value="$1"
    local default="$2"
    local max="$3"

    if [[ ! "$value" =~ ^[0-9]+$ ]] || (( value < 1 )); then
        value="$default"
    elif (( value > max )); then
        value="$max"
    fi

    printf '%s\n' "$value"
}

_pkg_configure_zypper_ci_network() {
    [[ "$PKG_MANAGER" == "zypper" ]] || return 0
    [[ -n "${GITHUB_ACTIONS:-}" || -n "${CI:-}" ]] || return 0

    local conf_dir="${ODS_ZYPPER_CI_CONF_DIR:-/etc/zypp/zypp.conf.d}"
    local conf_file="${conf_dir}/99-ods-ci-network.conf"
    local transfer_timeout connect_timeout max_silent_tries
    local tmp

    transfer_timeout="$(_pkg_bounded_positive_int "${ODS_ZYPPER_CI_TRANSFER_TIMEOUT:-180}" 180 180)"
    connect_timeout="$(_pkg_bounded_positive_int "${ODS_ZYPPER_CI_CONNECT_TIMEOUT:-30}" 30 30)"
    max_silent_tries="$(_pkg_bounded_positive_int "${ODS_ZYPPER_CI_MAX_SILENT_TRIES:-3}" 3 3)"

    tmp="$(mktemp "${TMPDIR:-/tmp}/ods-zypp-ci-network.XXXXXX")" || return 0

    cat >"$tmp" <<EOF
[main]
download.transfer_timeout = ${transfer_timeout}
download.connect_timeout = ${connect_timeout}
download.min_download_speed = 0
download.max_silent_tries = ${max_silent_tries}
download.max_concurrent_connections = 2
EOF

    _pkg_run mkdir -p "$conf_dir" 2>>"$LOG_FILE" || {
        rm -f "$tmp"
        return 0
    }
    _pkg_run cp "$tmp" "$conf_file" 2>>"$LOG_FILE" || true
    rm -f "$tmp"
}

# Detect the system's package manager from /etc/os-release
# Sets: PKG_MANAGER, DISTRO_ID, DISTRO_ID_LIKE
detect_pkg_manager() {
    if [[ -f /etc/os-release ]]; then
        local _saved_version="${VERSION:-}"
        # shellcheck source=/dev/null
        source /etc/os-release
        VERSION="$_saved_version"
        DISTRO_ID="${ID:-unknown}"
        DISTRO_ID_LIKE="${ID_LIKE:-}"
    else
        DISTRO_ID="unknown"
        DISTRO_ID_LIKE=""
    fi

    # Normalize: check ID first, then ID_LIKE for derivatives
    case "$DISTRO_ID" in
        ubuntu|debian|linuxmint|pop|elementary|zorin|kali|raspbian)
            PKG_MANAGER="apt" ;;
        fedora|rhel|centos|rocky|alma|nobara)
            PKG_MANAGER="dnf" ;;
        arch|cachyos|manjaro|endeavouros|garuda|artix)
            PKG_MANAGER="pacman" ;;
        opensuse*|sles)
            PKG_MANAGER="zypper" ;;
        void)
            PKG_MANAGER="xbps" ;;
        alpine)
            PKG_MANAGER="apk" ;;
        *)
            # Fallback: check ID_LIKE for derivative distros
            case "$DISTRO_ID_LIKE" in
                *debian*|*ubuntu*)  PKG_MANAGER="apt" ;;
                *fedora*|*rhel*)    PKG_MANAGER="dnf" ;;
                *arch*)             PKG_MANAGER="pacman" ;;
                *suse*)             PKG_MANAGER="zypper" ;;
                *)
                    # Last resort: check what's actually installed
                    if command -v apt-get &>/dev/null; then
                        PKG_MANAGER="apt"
                    elif command -v dnf &>/dev/null; then
                        PKG_MANAGER="dnf"
                    elif command -v pacman &>/dev/null; then
                        PKG_MANAGER="pacman"
                    elif command -v zypper &>/dev/null; then
                        PKG_MANAGER="zypper"
                    else
                        PKG_MANAGER="unknown"
                    fi
                    ;;
            esac
            ;;
    esac

    # Record Homebrew availability (cross-platform: brew also runs on Linux).
    if _brew_bin >/dev/null 2>&1; then
        HAS_BREW=1
    fi

    # macOS has no /etc/os-release and none of the Linux managers above, so it
    # falls through to "unknown". Homebrew is the package manager there.
    if [[ "$(uname -s 2>/dev/null || true)" == "Darwin" ]]; then
        if [[ -n "$HAS_BREW" ]]; then
            PKG_MANAGER="brew"
        fi
    fi
    # On Linux the native manager (apt/dnf/…) stays authoritative so Docker and
    # other system daemons are never installed from brew; HAS_BREW just records
    # that brew is available for the paths that prefer it (e.g. Python tooling).

    log "Detected distro: ${DISTRO_ID} (like: ${DISTRO_ID_LIKE:-none}, pkg: ${PKG_MANAGER}, brew: ${HAS_BREW:-0})"
}

# Update the package index
pkg_update() {
    case "$PKG_MANAGER" in
        apt)    _pkg_run apt-get update -qq 2>>"$LOG_FILE" ;;
        dnf)    _pkg_run dnf check-update -q 2>>"$LOG_FILE" || true ;;  # returns 100 if updates available
        pacman) _pkg_prepare_pacman_keyrings; _pkg_retry pacman -Syyu --noconfirm 2>>"$LOG_FILE" ;;  # full sync+upgrade (partial -Sy is unsafe)
        zypper)
            _pkg_configure_zypper_ci_network
            if [[ -n "${GITHUB_ACTIONS:-}" || -n "${CI:-}" ]]; then
                log "Skipping zypper refresh in CI; package installs use container image metadata"
            else
                _pkg_retry zypper --non-interactive --gpg-auto-import-keys refresh 2>>"$LOG_FILE"
            fi
            ;;
        xbps)   _pkg_run xbps-install -S 2>>"$LOG_FILE" ;;
        apk)    _pkg_run apk update 2>>"$LOG_FILE" ;;
        brew)   _brew_run update 2>>"$LOG_FILE" ;;
        *)      warn "Cannot update package index: unknown package manager '$PKG_MANAGER'" ;;
    esac
}

# Install one or more packages
# Usage: pkg_install curl jq rsync
pkg_install() {
    local requested=("$@")
    local pkgs=()
    local pkg resolved
    for pkg in "${requested[@]}"; do
        resolved="$(pkg_resolve "$pkg")"
        # Some canonical packages intentionally expand to multiple packages.
        # shellcheck disable=SC2206
        pkgs+=($resolved)
    done
    [[ ${#pkgs[@]} -eq 0 ]] && return 0

    log "Installing packages (${PKG_MANAGER}): ${pkgs[*]}"
    case "$PKG_MANAGER" in
        apt)    _pkg_run apt-get install -y -qq "${pkgs[@]}" 2>>"$LOG_FILE" ;;
        dnf)    _pkg_run dnf install -y -q "${pkgs[@]}" 2>>"$LOG_FILE" ;;
        pacman) _pkg_prepare_pacman_keyrings; _pkg_retry pacman -S --noconfirm --needed "${pkgs[@]}" 2>>"$LOG_FILE" ;;
        zypper)
            _pkg_configure_zypper_ci_network
            if [[ -n "${GITHUB_ACTIONS:-}" || -n "${CI:-}" ]]; then
                _pkg_retry zypper --non-interactive --no-refresh install -y "${pkgs[@]}" 2>>"$LOG_FILE"
            else
                _pkg_retry zypper --non-interactive install -y "${pkgs[@]}" 2>>"$LOG_FILE"
            fi
            ;;
        xbps)   _pkg_run xbps-install -y "${pkgs[@]}" 2>>"$LOG_FILE" ;;
        apk)    _pkg_run apk add --no-progress "${pkgs[@]}" 2>>"$LOG_FILE" ;;
        brew)   _brew_run install "${pkgs[@]}" 2>>"$LOG_FILE" ;;
        *)      warn "Cannot install packages: unknown package manager '$PKG_MANAGER'. Install manually: ${pkgs[*]}" ; return 1 ;;
    esac
}

# Check if a package is available in the repos
# Usage: if pkg_available jq; then ...
pkg_available() {
    local pkg="$1"
    case "$PKG_MANAGER" in
        apt)    apt-cache show "$pkg" &>/dev/null ;;
        dnf)    dnf info "$pkg" &>/dev/null ;;
        pacman) pacman -Si "$pkg" &>/dev/null ;;
        zypper) zypper info "$pkg" &>/dev/null ;;
        xbps)   xbps-query -Rs "$pkg" &>/dev/null ;;
        apk)    apk info -e "$pkg" &>/dev/null || apk search -q "$pkg" &>/dev/null ;;
        brew)   _brew_run info "$pkg" &>/dev/null ;;
        *)      return 1 ;;
    esac
}

# Map a canonical package name to distro-specific name where needed
# Usage: pkg_name=$(pkg_resolve docker-compose-plugin)
pkg_resolve() {
    local canonical="$1"
    case "$PKG_MANAGER" in
        apt)
            case "$canonical" in
                docker-compose-plugin) echo "docker-compose-plugin" ;;
                python3-pyyaml)        echo "python3-yaml" ;;
                python3-pip)           echo "python3-pip" ;;
                *) echo "$canonical" ;;
            esac
            ;;
        dnf)
            case "$canonical" in
                curl)
                    if command -v rpm &>/dev/null && rpm -q curl-minimal &>/dev/null; then
                        echo "curl-minimal"
                    else
                        echo "curl"
                    fi
                    ;;
                docker-compose-plugin) echo "docker-compose-plugin" ;;
                python3-pyyaml)        echo "python3-pyyaml" ;;
                python3-pip)           echo "python3-pip" ;;
                build-essential)       echo "gcc gcc-c++ make" ;;
                *) echo "$canonical" ;;
            esac
            ;;
        pacman)
            case "$canonical" in
                docker-compose-plugin) echo "docker-compose" ;;
                python3-pyyaml)        echo "python-yaml" ;;
                python3-pip)           echo "python-pip" ;;
                python3-zeroconf)      echo "python-zeroconf" ;;
                build-essential)       echo "base-devel" ;;
                *) echo "$canonical" ;;
            esac
            ;;
        zypper)
            case "$canonical" in
                docker-compose-plugin) echo "docker-compose" ;;
                python3-pyyaml)        echo "python3-PyYAML" ;;
                python3-pip)           echo "python3-pip" ;;
                build-essential)       echo "devel_basis" ;;
                *) echo "$canonical" ;;
            esac
            ;;
        xbps)
            case "$canonical" in
                docker-compose-plugin) echo "docker-compose" ;;
                python3-pyyaml)        echo "python3-yaml" ;;
                python3-pip)           echo "python3-pip" ;;
                build-essential)       echo "base-devel" ;;
                *) echo "$canonical" ;;
            esac
            ;;
        apk)
            case "$canonical" in
                docker-compose-plugin) echo "docker-cli-compose" ;;
                python3-pyyaml)        echo "py3-yaml" ;;
                python3-pip)           echo "py3-pip" ;;
                python3-zeroconf)      echo "py3-zeroconf" ;;
                build-essential)       echo "build-base" ;;
                *) echo "$canonical" ;;
            esac
            ;;
        brew)
            case "$canonical" in
                docker-compose-plugin) echo "docker-compose" ;;
                python3-pip)           echo "python" ;;  # pip ships with the python formula
                # No brew formula — these are Python libs (pip/venv) or handled by
                # Xcode CLT. Resolve to empty; pkg_install drops empty entries.
                python3-pyyaml|python3-zeroconf|build-essential) echo "" ;;
                *) echo "$canonical" ;;
            esac
            ;;
        *)
            echo "$canonical" ;;
    esac
}
