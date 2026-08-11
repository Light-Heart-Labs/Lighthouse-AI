#!/usr/bin/env bash
# Verify every enabled service has the secrets its manifest marks required.
#
# Service manifests declare which env vars a service cannot run correctly
# without (`required: true`), but nothing checked that at runtime. An empty
# value is not the same as a missing one to the services that consume them:
# Qdrant treats an empty QDRANT__SERVICE__API_KEY as "no API key configured"
# and serves every request unauthenticated, and an empty LITELLM_MASTER_KEY
# disables gateway auth. config/network-exposure-policy.json marks both
# auth_required: true, so an empty value is a silent disagreement between the
# declared posture and the running one.
#
# The installers generate these keys, so this only fires on a hand-edited or
# hand-migrated .env — which is exactly the case nothing else catches.
#
# usage: check-required-secrets.sh [ODS_DIR]
# exit 0 = all present, 1 = at least one enabled service is missing one.

set -uo pipefail

ODS_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_FILE="$ODS_DIR/.env"
SERVICES_DIR="$ODS_DIR/extensions/services"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

problems=0
checked=0

# Emit the keys a manifest marks required, one per line.
#
# A small awk pass rather than a YAML dependency on purpose: this runs from
# preflight, before any Python environment is guaranteed to exist.
manifest_required_secrets() {
    awk '
        /^[[:space:]]*env_vars:/ { in_env = 1; next }
        in_env && /^[[:space:]]*-[[:space:]]*key:[[:space:]]*/ {
            key = $0
            sub(/^[[:space:]]*-[[:space:]]*key:[[:space:]]*/, "", key)
            gsub(/[[:space:]]|"|'"'"'/, "", key)
            pending = key
            required = 0
            next
        }
        in_env && /^[[:space:]]*required:[[:space:]]*true/ { required = 1 }
        in_env && /^[[:space:]]*(secret|description):/ {
            if (pending != "" && required) { print pending; pending = ""; required = 0 }
        }
        /^[a-zA-Z]/ && !/^[[:space:]]/ { in_env = 0 }
    ' "$1" | sort -u
}

# Read one key out of .env without sourcing it. The file is user-editable, so
# it is never eval'd here.
env_value() {
    local key="$1"
    [[ -f "$ENV_FILE" ]] || return 0
    sed -n "s/^[[:space:]]*${key}[[:space:]]*=//p" "$ENV_FILE" \
        | tail -n 1 \
        | tr -d '\r' \
        | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//'
}

for manifest in "$SERVICES_DIR"/*/manifest.yaml; do
    [[ -f "$manifest" ]] || continue
    svc_dir="$(dirname "$manifest")"
    svc="$(basename "$svc_dir")"

    # Only enabled services matter. Enablement is on-disk state: compose.yaml
    # present versus compose.yaml.disabled, which the installer's
    # _sync_extension_compose and the dashboard's enable/disable routes both
    # maintain.
    [[ -f "$svc_dir/compose.yaml" ]] || continue

    while IFS= read -r key; do
        [[ -n "$key" ]] || continue
        checked=$((checked + 1))
        value="$(env_value "$key")"
        if [[ -z "$value" ]]; then
            echo -e "${RED}✗${NC} $svc is enabled but $key is empty or missing in .env"
            problems=$((problems + 1))
        elif [[ "$value" == "CHANGEME" ]]; then
            echo -e "${RED}✗${NC} $svc is enabled but $key is still the CHANGEME placeholder"
            problems=$((problems + 1))
        fi
    done < <(manifest_required_secrets "$manifest")
done

if [[ "$problems" -gt 0 ]]; then
    echo -e "${RED}✗${NC} $problems required secret(s) missing — the installer normally generates these."
    echo "  Re-run the installer, or set them in $ENV_FILE, then restart the stack."
    exit 1
fi

if [[ "$checked" -eq 0 ]]; then
    echo -e "${YELLOW}⚠${NC} No enabled service declares a required secret"
else
    echo -e "${GREEN}✓${NC} Required secrets present for all enabled services ($checked checked)"
fi
exit 0
