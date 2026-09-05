#!/bin/sh
# Typesense - generate an administrator key without replacing an operator value.

set -eu

ENV_FILE="${1:-.}/.env"

if [ -f "$ENV_FILE" ] && grep -q '^TYPESENSE_API_KEY=' "$ENV_FILE"; then
  exit 0
fi

command -v openssl >/dev/null 2>&1 || {
  echo "ERROR: openssl is required to generate the Typesense API key" >&2
  exit 1
}

printf 'TYPESENSE_API_KEY=%s\n' "$(openssl rand -hex 32)" >> "$ENV_FILE"
