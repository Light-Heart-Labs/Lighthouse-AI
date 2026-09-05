#!/usr/bin/env bash
#
# llm-cold-storage.sh — Archive idle HuggingFace models to cold storage
#
# Part of ODS tooling.
#
# Models not accessed in 7+ days are moved to cold storage on a backup drive.
# A symlink replaces the original so HuggingFace cache resolution still works.
# Models can be restored manually or are auto-detected if a process loads them.
#
# Usage:
#   ./llm-cold-storage.sh                  # Archive idle models (dry-run)
#   ./llm-cold-storage.sh --execute        # Archive idle models (for real)
#   ./llm-cold-storage.sh --restore <name> # Restore a specific model
#   ./llm-cold-storage.sh --restore-all    # Restore all archived models
#   ./llm-cold-storage.sh --status         # Show archive status
#   ./llm-cold-storage.sh --status --json  # Machine-readable inventory
#
set -uo pipefail

HF_CACHE="${HF_CACHE:-$HOME/.cache/huggingface/hub}"
COLD_DIR="${COLD_DIR:-$HOME/llm-cold-storage}"
LOG_FILE="${LOG_FILE:-$HOME/.local/log/llm-cold-storage.log}"
MAX_IDLE_DAYS=7

# Ensure the log directory exists
mkdir -p "$(dirname "$LOG_FILE")"

# Models to never archive (currently serving or critical)
PROTECTED_MODELS=(
    "models--BAAI--bge-base-en-v1.5"
    "models--Systran--faster-whisper-base"
    "models--sentence-transformers--all-MiniLM-L6-v2"
)

log() {
    local msg
    msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
    echo "$msg" | tee -a "$LOG_FILE"
}

is_protected() {
    local name="$1"
    for p in "${PROTECTED_MODELS[@]}"; do
        [[ "$name" == "$p" ]] && return 0
    done
    return 1
}

is_model_in_use() {
    local name="$1"
    # Extract model identifier: models--Org--Name -> Org/Name
    local model_id
    model_id="$(echo "$name" | sed 's/^models--//; s/--/\//g')"

    # Check if any running process references this model
    if pgrep -f "$model_id" > /dev/null 2>&1; then
        return 0
    fi
    return 1
}

get_last_access_days() {
    local dir="$1"
    # Find most recent atime across all files in $dir using portable stat
    # (BSD `find -printf` is unavailable on macOS).
    local newest_atime=""
    if [[ "$(uname -s)" == "Darwin" ]]; then
        # BSD: stat -f %a (atime as epoch seconds)
        newest_atime="$(find "$dir" -type f -exec stat -f %a {} + 2>/dev/null | sort -rn | sed -n '1p')"
    else
        # GNU: stat -c %X (atime as epoch seconds)
        newest_atime="$(find "$dir" -type f -exec stat -c %X {} + 2>/dev/null | sort -rn | sed -n '1p')"
    fi
    if [[ -z "$newest_atime" ]]; then
        echo "9999"
        return
    fi
    local now
    now="$(date +%s)"
    local age_secs
    age_secs="$(echo "$now - ${newest_atime%.*}" | bc)"
    echo "$(( age_secs / 86400 ))"
}

do_archive() {
    local dry_run="${1:-true}"
    local archived=0
    local skipped=0

    log "========== LLM cold storage scan started (dry_run=$dry_run) =========="

    for model_dir in "$HF_CACHE"/models--*/; do
        [[ -d "$model_dir" ]] || continue
        # Skip if already a symlink (already archived)
        [[ -L "${model_dir%/}" ]] && continue

        local name
        name="$(basename "$model_dir")"

        # Skip protected models
        if is_protected "$name"; then
            log "SKIP (protected): $name"
            ((skipped++))
            continue
        fi

        # Skip if actively in use by a process
        if is_model_in_use "$name"; then
            log "SKIP (in use): $name"
            ((skipped++))
            continue
        fi

        local idle_days
        idle_days="$(get_last_access_days "$model_dir")"
        local size
        size="$(du -sh "$model_dir" 2>/dev/null | cut -f1)"

        if (( idle_days >= MAX_IDLE_DAYS )); then
            if [[ "$dry_run" == "true" ]]; then
                log "WOULD ARCHIVE: $name ($size, idle ${idle_days}d)"
            else
                log "ARCHIVING: $name ($size, idle ${idle_days}d)"
                # Move to cold storage
                mv "$model_dir" "$COLD_DIR/$name"
                # Create symlink so HF cache still resolves
                ln -s "$COLD_DIR/$name" "${model_dir%/}"
                log "ARCHIVED: $name -> $COLD_DIR/$name"
            fi
            ((archived++))
        else
            log "SKIP (recent, ${idle_days}d): $name ($size)"
            ((skipped++))
        fi
    done

    log "========== Scan complete: $archived archived, $skipped skipped =========="
}

do_restore() {
    local name="$1"

    # Normalize: accept "Qwen/Qwen2.5-7B" or "models--Qwen--Qwen2.5-7B"
    if [[ "$name" != models--* ]]; then
        name="models--$(echo "$name" | sed 's/\//--/g')"
    fi

    local cold_path="$COLD_DIR/$name"
    local cache_path="$HF_CACHE/$name"

    if [[ ! -d "$cold_path" ]]; then
        echo "ERROR: Model not found in cold storage: $cold_path"
        exit 1
    fi

    # Remove symlink if it exists
    if [[ -L "$cache_path" ]]; then
        rm "$cache_path"
    fi

    log "RESTORING: $name to $cache_path"
    mv "$cold_path" "$cache_path"
    log "RESTORED: $name"
    echo "Restored: $name"
}

do_restore_all() {
    log "========== Restoring all archived models =========="
    for cold_model in "$COLD_DIR"/models--*/; do
        [[ -d "$cold_model" ]] || continue
        local name
        name="$(basename "$cold_model")"
        local cache_path="$HF_CACHE/$name"

        if [[ -L "$cache_path" ]]; then
            rm "$cache_path"
        fi

        log "RESTORING: $name"
        mv "$cold_model" "$cache_path"
        log "RESTORED: $name"
    done
    log "========== All models restored =========="
}

show_status() {
    echo "=== LLM Cold Storage Status ==="
    echo ""

    echo "Active models (on NVMe):"
    for model_dir in "$HF_CACHE"/models--*/; do
        [[ -d "$model_dir" ]] || continue
        local name
        name="$(basename "$model_dir")"
        if [[ -L "${model_dir%/}" ]]; then
            local size
            size="$(du -sh "$model_dir" 2>/dev/null | cut -f1)"
            echo "  [SYMLINK -> cold] $name ($size)"
        else
            local size idle_days status=""
            size="$(du -sh "$model_dir" 2>/dev/null | cut -f1)"
            idle_days="$(get_last_access_days "$model_dir")"
            is_protected "$name" && status=" [protected]"
            is_model_in_use "$name" && status=" [in use]"
            echo "  [HOT] $name ($size, idle ${idle_days}d)${status}"
        fi
    done

    echo ""
    echo "Archived models (on backup SSD):"
    local has_archived=false
    for cold_model in "$COLD_DIR"/models--*/; do
        [[ -d "$cold_model" ]] || continue
        has_archived=true
        local name size
        name="$(basename "$cold_model")"
        size="$(du -sh "$cold_model" 2>/dev/null | cut -f1)"
        echo "  [COLD] $name ($size)"
    done
    $has_archived || echo "  (none)"

    echo ""
    echo "NVMe cache total: $(du -sh "$HF_CACHE" 2>/dev/null | cut -f1)"
    echo "Cold storage total: $(du -sh "$COLD_DIR" 2>/dev/null | cut -f1)"
}

json_escape() {
    local value="${1-}"
    value=${value//\\/\\\\}
    value=${value//\"/\\\"}
    value=${value//$'\n'/\\n}
    value=${value//$'\r'/\\r}
    value=${value//$'\t'/\\t}
    printf '%s' "$value"
}

du_size() {
    local path="$1" output
    if [[ ! -e "$path" ]]; then
        printf '0'
        return 0
    fi
    if ! output=$(du -sh "$path" 2>&1); then
        echo "ERROR: could not measure $path: $output" >&2
        return 1
    fi
    printf '%s' "${output%%$'\t'*}"
}

show_status_json() {
    local hot=0 cold_links=0 cold=0 comma="" model_dir cold_model
    local cache_total cold_total
    cache_total="$(du_size "$HF_CACHE")" || return 1
    cold_total="$(du_size "$COLD_DIR")" || return 1

    printf '{"schema_version":"1","kind":"llm-cold-storage-status",'
    printf '"paths":{"cache":"%s","cold_storage":"%s"},"models":[' \
        "$(json_escape "$HF_CACHE")" "$(json_escape "$COLD_DIR")"

    for model_dir in "$HF_CACHE"/models--*/; do
        [[ -d "$model_dir" ]] || continue
        local name size state idle_json protected=false in_use=false
        name="$(basename "$model_dir")"
        size="$(du_size "$model_dir")" || return 1
        if [[ -L "${model_dir%/}" ]]; then
            state="cold_link"
            idle_json="null"
            cold_links=$((cold_links + 1))
        else
            state="hot"
            idle_json="$(get_last_access_days "$model_dir")"
            is_protected "$name" && protected=true
            is_model_in_use "$name" && in_use=true
            hot=$((hot + 1))
        fi
        printf '%s{"name":"%s","state":"%s","size":"%s","idle_days":%s,' \
            "$comma" "$(json_escape "$name")" "$state" "$(json_escape "$size")" "$idle_json"
        printf '"protected":%s,"in_use":%s,"path":"%s"}' \
            "$protected" "$in_use" "$(json_escape "${model_dir%/}")"
        comma=","
    done

    for cold_model in "$COLD_DIR"/models--*/; do
        [[ -d "$cold_model" ]] || continue
        local name size
        name="$(basename "$cold_model")"
        size="$(du_size "$cold_model")" || return 1
        printf '%s{"name":"%s","state":"cold","size":"%s","idle_days":null,' \
            "$comma" "$(json_escape "$name")" "$(json_escape "$size")"
        printf '"protected":false,"in_use":false,"path":"%s"}' \
            "$(json_escape "${cold_model%/}")"
        comma=","
        cold=$((cold + 1))
    done

    printf '],"summary":{"hot":%d,"cold_links":%d,"cold":%d,' "$hot" "$cold_links" "$cold"
    printf '"cache_size":"%s","cold_storage_size":"%s"}}\n' \
        "$(json_escape "$cache_total")" "$(json_escape "$cold_total")"
}

ACTION=""
RESTORE_NAME=""
JSON_OUTPUT=false

select_action() {
    if [[ -n "$ACTION" && "$ACTION" != "$1" ]]; then
        echo "ERROR: choose exactly one cold-storage action" >&2
        exit 2
    fi
    ACTION="$1"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --execute) select_action "execute"; shift ;;
        --restore)
            select_action "restore"
            RESTORE_NAME="${2:-}"
            [[ -n "$RESTORE_NAME" ]] || { echo "Usage: $0 --restore <model-name>" >&2; exit 2; }
            shift 2
            ;;
        --restore-all) select_action "restore_all"; shift ;;
        --status) select_action "status"; shift ;;
        --json) JSON_OUTPUT=true; shift ;;
        --help|-h) select_action "help"; shift ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done

[[ -n "$ACTION" ]] || ACTION="dry_run"
if [[ "$JSON_OUTPUT" == "true" && "$ACTION" != "status" ]]; then
    echo "ERROR: --json is supported only with --status" >&2
    exit 2
fi

case "$ACTION" in
    execute)
        do_archive false
        ;;
    restore)
        do_restore "$RESTORE_NAME"
        ;;
    restore_all)
        do_restore_all
        ;;
    status)
        if [[ "$JSON_OUTPUT" == "true" ]]; then
            show_status_json
        else
            show_status
        fi
        ;;
    help)
        echo "Usage: $0 [--execute|--restore <name>|--restore-all|--status [--json]|--help]"
        echo ""
        echo "  (no args)            Dry-run: show what would be archived"
        echo "  --execute            Archive idle models (>$MAX_IDLE_DAYS days)"
        echo "  --restore <name>     Restore model from cold storage"
        echo "  --restore-all        Restore all archived models"
        echo "  --status             Show current hot/cold status"
        echo "  --status --json      Emit machine-readable hot/cold inventory"
        ;;
    dry_run)
        do_archive true
        ;;
esac
