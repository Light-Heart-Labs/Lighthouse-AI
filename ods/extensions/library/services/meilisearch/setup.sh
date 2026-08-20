#!/bin/sh
# Meilisearch - generate a master key without replacing an operator value.

set -eu

ENV_FILE="${1:-.}/.env"

if [ -f "$ENV_FILE" ] && grep -q '^MEILI_MASTER_KEY=' "$ENV_FILE"; then
  exit 0
fi

command -v openssl >/dev/null 2>&1 || {
  echo "ERROR: openssl is required to generate the Meilisearch master key" >&2
  exit 1
}

printf 'MEILI_MASTER_KEY=%s\n' "$(openssl rand -hex 32)" >> "$ENV_FILE"
