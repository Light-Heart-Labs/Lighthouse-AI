#!/usr/bin/env bash
# lib/logging.sh — Shared logging functions for ODS scripts
#
# Usage:
#   source "$ODS_DIR/lib/logging.sh"
#   log_info "Starting operation..."
#   log_ok "Operation complete"
#   log_warn "Non-critical issue"
#   log_error "Critical failure"
#   log_step "Step 1 of 3"
#
# NO_COLOR is respected per https://no-color.org/
# Set ODS_LOG_FILE to also append to a log file.

# Guard against double-sourcing
[[ -n "${_ODS_LOGGING_LOADED:-}" ]] && return 0
_ODS_LOGGING_LOADED=true

# Colors — disabled when NO_COLOR is set or stdout is not a TTY
if [[ -t 1 ]] && [[ -z "${NO_COLOR+x}" ]]; then
    _LOG_RED=$'\033[0;31m'
    _LOG_GREEN=$'\033[0;32m'
    _LOG_YELLOW=$'\033[1;33m'
    _LOG_BLUE=$'\033[0;34m'
    _LOG_CYAN=$'\033[0;36m'
    _LOG_NC=$'\033[0m'
else
    _LOG_RED=''
    _LOG_GREEN=''
    _LOG_YELLOW=''
    _LOG_BLUE=''
    _LOG_CYAN=''
    _LOG_NC=''
fi

_ods_log_write() {
    local level="$1" color="$2"
    shift 2
    local msg="${color}[${level}]${_LOG_NC} $*"
    echo -e "$msg"
    if [[ -n "${ODS_LOG_FILE:-}" ]]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$level] $*" >> "$ODS_LOG_FILE"
    fi
}

log_info()  { _ods_log_write "INFO"    "$_LOG_BLUE"   "$@"; }
log_ok()    { _ods_log_write "OK"      "$_LOG_GREEN"  "$@"; }
log_success() { _ods_log_write "OK"    "$_LOG_GREEN"  "$@"; }  # alias
log_warn()  { _ods_log_write "WARN"    "$_LOG_YELLOW" "$@"; }
log_error() { _ods_log_write "ERROR"   "$_LOG_RED"    "$@" >&2; }
log_step()  { _ods_log_write "STEP"    "$_LOG_CYAN"   "$@"; }
