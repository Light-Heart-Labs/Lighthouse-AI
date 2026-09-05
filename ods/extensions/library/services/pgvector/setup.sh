#!/bin/sh
# pgvector - generate a database password without replacing an operator value.

set -eu

ENV_FILE="${1:-.}/.env"

if [ -f "$ENV_FILE" ] && grep -q '^PGVECTOR_PASSWORD=' "$ENV_FILE"; then
  exit 0
fi

command -v openssl >/dev/null 2>&1 || {
  echo "ERROR: openssl is required to generate the pgvector password" >&2
  exit 1
}

printf 'PGVECTOR_PASSWORD=%s\n' "$(openssl rand -hex 32)" >> "$ENV_FILE"
