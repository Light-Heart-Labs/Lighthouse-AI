#!/usr/bin/env bash
# scripts/check-required-secrets.sh must catch an enabled service whose
# manifest-declared required secret is empty, and must stay quiet about
# services that are disabled or whose secret is set.
#
# The services that consume these do not treat empty as missing: Qdrant serves
# every request unauthenticated with an empty QDRANT__SERVICE__API_KEY, and an
# empty LITELLM_MASTER_KEY disables gateway auth — while
# config/network-exposure-policy.json marks both auth_required: true.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKER="$SCRIPT_DIR/../scripts/check-required-secrets.sh"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

pass() { echo -e "${GREEN}✓${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; exit 1; }

[[ -f "$CHECKER" ]] || fail "check-required-secrets.sh not found"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Build a disposable ODS root with one service that declares a required
# secret, mirroring the shape of a real manifest.
make_root() {
    local root="$1" enabled="$2" env_line="$3"
    local svc="$root/extensions/services/faux"
    mkdir -p "$svc"
    cat > "$svc/manifest.yaml" <<'YAML'
schema_version: ods.services.v1
service:
  id: faux
  name: Faux Service
  env_vars:
    - key: FAUX_API_KEY
      required: true
      secret: true
      description: Faux service API key
YAML
    if [[ "$enabled" == "enabled" ]]; then
        echo "services: {}" > "$svc/compose.yaml"
    else
        echo "services: {}" > "$svc/compose.yaml.disabled"
    fi
    printf '%s\n' "$env_line" > "$root/.env"
}

run_checker() {
    bash "$CHECKER" "$1" > "$TMP/out.txt" 2>&1
    echo $?
}

# --- an enabled service with an empty secret must fail ----------------------

R="$TMP/empty"; make_root "$R" enabled "FAUX_API_KEY="
rc="$(run_checker "$R")"
[[ "$rc" -ne 0 ]] || fail "Expected nonzero exit for an empty required secret, got $rc"
grep -q "FAUX_API_KEY" "$TMP/out.txt" || fail "Error must name the missing key: $(cat "$TMP/out.txt")"
pass "Enabled service with an empty required secret fails"

# --- entirely absent from .env is the same problem --------------------------

R="$TMP/absent"; make_root "$R" enabled "SOMETHING_ELSE=x"
rc="$(run_checker "$R")"
[[ "$rc" -ne 0 ]] || fail "Expected nonzero exit for a missing required secret, got $rc"
pass "Enabled service with the secret absent from .env fails"

# --- the CHANGEME placeholder is not a real value ---------------------------

R="$TMP/changeme"; make_root "$R" enabled "FAUX_API_KEY=CHANGEME"
rc="$(run_checker "$R")"
[[ "$rc" -ne 0 ]] || fail "Expected nonzero exit for a CHANGEME placeholder, got $rc"
grep -qi "changeme" "$TMP/out.txt" || fail "Error should mention the placeholder"
pass "CHANGEME placeholder is rejected"

# --- a set secret passes ----------------------------------------------------

R="$TMP/ok"; make_root "$R" enabled "FAUX_API_KEY=a-real-looking-secret"
rc="$(run_checker "$R")"
[[ "$rc" -eq 0 ]] || fail "Expected exit 0 when the secret is set, got $rc: $(cat "$TMP/out.txt")"
pass "Enabled service with the secret set passes"

# --- a DISABLED service is not checked --------------------------------------
# Guards against over-blocking: an operator who never enabled qdrant must not
# be told to set QDRANT_API_KEY.

R="$TMP/disabled"; make_root "$R" disabled "SOMETHING_ELSE=x"
rc="$(run_checker "$R")"
[[ "$rc" -eq 0 ]] || fail "A disabled service must not be checked, got $rc: $(cat "$TMP/out.txt")"
pass "Disabled service is not checked"

# --- quoted values are read correctly ---------------------------------------

R="$TMP/quoted"; make_root "$R" enabled 'FAUX_API_KEY="quoted-secret"'
rc="$(run_checker "$R")"
[[ "$rc" -eq 0 ]] || fail "A quoted value must count as set, got $rc: $(cat "$TMP/out.txt")"
pass "Quoted .env values are read correctly"

# --- the shipped manifests are actually covered -----------------------------
# qdrant and litellm are the two this exists for; if either stops declaring
# its secret the check silently stops protecting it.

for svc in qdrant litellm; do
    m="$SCRIPT_DIR/../extensions/services/$svc/manifest.yaml"
    grep -q "required: true" "$m" \
        || fail "$svc/manifest.yaml must declare a required secret for the check to cover it"
done
pass "qdrant and litellm declare their required secrets"

echo "All required-secret checks passed"
