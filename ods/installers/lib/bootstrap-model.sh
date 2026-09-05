#!/bin/bash
# ============================================================================
# ODS Installer — Bootstrap Model Library
# ============================================================================
# Part of: installers/lib/
# Purpose: Constants and helpers for the bootstrap model fast-start pattern.
#          Downloads a tiny model first so the user can chat immediately,
#          while the full tier-appropriate model downloads in the background.
#
# Expects: TIER, GGUF_FILE, INSTALL_DIR, NO_BOOTSTRAP, OFFLINE_MODE,
#           ODS_MODE, tier_rank()
# Provides: BOOTSTRAP_* constants (incl. BOOTSTRAP_GGUF_SIZE_MB), bootstrap_needed()
# ============================================================================

# Bootstrap model: Tier 0 (Qwen 3.5 2B, Q4_K_M quantization, ~1.22 GiB).
# Hermes requires at least a 64K context window, so fast-start installs keep
# the bootstrap server at that floor instead of the older 8K default.
# HOWEVER: on entry-level discrete GPUs (< 8GB VRAM), a 64K context + 2B model
# can OOM the llama-server. For those systems, cap at 16K to keep the bootstrap
# runnable while the full-model download proceeds in the background.
BOOTSTRAP_GGUF_FILE="Qwen3.5-2B-Q4_K_M.gguf"
# Exact artifact size rounded down to MiB. This is display metadata for the
# pinned GGUF below; keep it aligned with tier-map.sh when the artifact changes.
BOOTSTRAP_GGUF_SIZE_MB=1221
BOOTSTRAP_GGUF_URL="https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q4_K_M.gguf"
BOOTSTRAP_GGUF_SHA256="aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223"
BOOTSTRAP_LLM_MODEL="qwen3.5-2b"
BOOTSTRAP_MAX_CONTEXT=65536

calculate_bootstrap_context() {
    # Allow explicit override via environment
    if [[ -n "${HERMES_CONTEXT_SIZE:-}" ]]; then
        BOOTSTRAP_MAX_CONTEXT="$HERMES_CONTEXT_SIZE"
        return 0
    fi

    # Unified memory backends (Apple Metal, AMD unified, Jetson) can handle full context
    if [[ "${GPU_MEMORY_TYPE:-none}" == "unified" ]]; then
        BOOTSTRAP_MAX_CONTEXT=65536
        return 0
    fi

    # CPU-only systems have no constraints
    if [[ "${GPU_BACKEND:-cpu}" == "cpu" ]]; then
        BOOTSTRAP_MAX_CONTEXT=65536
        return 0
    fi

    # Discrete GPUs with very limited VRAM: use a reduced context to prevent OOM
    # On 4-6GB cards, a 2B model + 16K context fits; 8K is safer for margin
    local vram_mb="${GPU_VRAM:-0}"
    if [[ "$vram_mb" -gt 0 && "$vram_mb" -lt 8192 && "${GPU_MEMORY_TYPE:-none}" == "discrete" ]]; then
        # Scale context based on available VRAM: aim for ~50% utilization headroom
        # 4GB card: 8K context, 6GB card: 12K context, 8GB card: 16K context
        # Formula: min(16384, VRAM_MB * 2)
        BOOTSTRAP_MAX_CONTEXT=$((vram_mb * 2))
        if [[ $BOOTSTRAP_MAX_CONTEXT -gt 16384 ]]; then
            BOOTSTRAP_MAX_CONTEXT=16384
        fi
        return 0
    fi

    # Default: full context
    BOOTSTRAP_MAX_CONTEXT=65536
}

# bootstrap_needed — Should we use the fast-start bootstrap pattern?
#
# Returns 0 (true) when ALL of these hold:
#   1. Tier is above 0 (full model is larger than the bootstrap model)
#   2. Full model GGUF file does NOT already exist on disk
#   3. --no-bootstrap flag was NOT set
#   4. Not in offline mode (can't download anything)
#   5. Not in cloud mode (no local model needed)
#
bootstrap_needed() {
    local tier_rank
    tier_rank="$(tier_rank "$TIER")"

    # Tier 0: the full model IS the bootstrap model — no point
    [[ "$tier_rank" -le 0 ]] && return 1

    # Full model already on disk — skip bootstrap, use it directly
    [[ -f "${INSTALL_DIR}/data/models/${GGUF_FILE}" ]] && return 1

    # User opted out
    [[ "${NO_BOOTSTRAP:-false}" == "true" ]] && return 1

    # Offline mode — can't download anything
    [[ "${OFFLINE_MODE:-false}" == "true" ]] && return 1

    # Cloud mode — no local model needed
    [[ "${ODS_MODE:-local}" == "cloud" ]] && return 1
    [[ "${LEMONADE_EXTERNAL:-false}" == "true" ]] && return 1

    return 0
}
