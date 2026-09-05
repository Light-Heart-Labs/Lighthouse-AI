#!/bin/sh
# FalkorDB - generate stable database and Browser secrets once.

set -eu

ENV_FILE="${1:-.}/.env"

append_if_missing() {
  key="$1"
  value="$2"
  if [ -f "$ENV_FILE" ] && grep -q "^${key}=" "$ENV_FILE"; then
    return 0
  fi
  printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
}

command -v openssl >/dev/null 2>&1 || {
  echo "ERROR: openssl is required to generate FalkorDB credentials" >&2
  exit 1
}

append_if_missing "FALKORDB_PASSWORD" "$(openssl rand -hex 32)"
append_if_missing "FALKORDB_AUTH_SECRET" "$(openssl rand -hex 32)"
append_if_missing "FALKORDB_ENCRYPTION_KEY" "$(openssl rand -hex 32)"
