#!/bin/bash
# Shared user-data paths for ODS backup and restore.
#
# Keep estimate/backup/restore/dry-run previews in sync by sourcing this file
# instead of re-listing bind-mounted product state in each script.
#
# Hermes (`data/hermes`) holds sessions, skills, memories, cron jobs, and audit
# logs. Persona (`data/persona`) holds the operator-authored SOUL.md and related
# OAuth state. Both are bind-mounted product state and must survive full
# backup → wipe → restore.

# shellcheck disable=SC2034
ODS_USER_DATA_PATHS=(
    "data/open-webui"
    "data/n8n"
    "data/qdrant"
    "data/openclaw"
    "data/litellm"
    "data/livekit"
    "data/ollama"
    "data/hermes"
    "data/persona"
)
