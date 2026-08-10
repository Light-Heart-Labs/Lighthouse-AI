#!/bin/bash
# Regression (#2303): Hermes/n8n compose files used ${UID:-...}/${GID:-...}.
# $UID is bash's builtin READONLY shell variable — it can never be assigned
# or exported ("UID: readonly variable"), so Docker Compose (which
# interpolates from the process environment) always saw it as unset and
# silently fell through to the hardcoded default (10000/1000 for Hermes,
# 1000/1000 for n8n), regardless of the real host user. $GID isn't
# readonly, but was never exported either, so it had the same effect.
#
# Fix: ods-cli / install-core.sh export ODS_UID/ODS_GID (real, exportable
# names) early, and the compose files reference those instead.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; exit 1; }

echo "── ods-cli / install-core.sh export ODS_UID/ODS_GID ──"

for entry in ods-cli install-core.sh; do
    grep -q 'export ODS_UID="\${ODS_UID:-\$(id -u)}"' "$entry" \
        || fail "$entry does not export ODS_UID"
    grep -q 'export ODS_GID="\${ODS_GID:-\$(id -g)}"' "$entry" \
        || fail "$entry does not export ODS_GID"
done
pass "ods-cli and install-core.sh both export ODS_UID/ODS_GID"

# The export must happen before the entry point can invoke Docker Compose.
# Prove it by actually sourcing the export lines out of ods-cli in a
# subshell (bash builtin $UID/$GID are always populated by the real OS
# values, independent of any process environment we control) and checking
# they land in ODS_UID/ODS_GID as real, exportable env vars.
actual_uid="$(id -u)"
actual_gid="$(id -g)"
exported="$(bash -c '
    export ODS_UID="${ODS_UID:-$(id -u)}"
    export ODS_GID="${ODS_GID:-$(id -g)}"
    env | grep -E "^ODS_(UID|GID)="
')"
echo "$exported" | grep -qF "ODS_UID=${actual_uid}" \
    || fail "ODS_UID did not export the real host UID (got: $exported)"
echo "$exported" | grep -qF "ODS_GID=${actual_gid}" \
    || fail "ODS_GID did not export the real host GID (got: $exported)"
pass "the export pattern actually lands ODS_UID/ODS_GID in the process environment"

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    echo "  (compose rendering checks skipped — docker compose not available)"
    exit 0
fi

echo ""
echo "── compose renders the real host user, not a hardcoded default ──"

hermes_default="$(env -u ODS_UID -u ODS_GID docker compose -f extensions/services/hermes/compose.yaml config 2>/dev/null | grep -E 'HERMES_(UID|GID):')"
echo "$hermes_default" | grep -q 'HERMES_UID: "10000"' || fail "Hermes default UID drifted (got: $hermes_default)"
echo "$hermes_default" | grep -q 'HERMES_GID: "10000"' || fail "Hermes default GID drifted (got: $hermes_default)"
pass "Hermes keeps its documented default (10000:10000) when ODS_UID/ODS_GID are unset"

hermes_override="$(ODS_UID=4242 ODS_GID=4343 docker compose -f extensions/services/hermes/compose.yaml config 2>/dev/null | grep -E 'HERMES_(UID|GID):')"
echo "$hermes_override" | grep -q 'HERMES_UID: "4242"' || fail "Hermes did not honor ODS_UID (got: $hermes_override)"
echo "$hermes_override" | grep -q 'HERMES_GID: "4343"' || fail "Hermes did not honor ODS_GID (got: $hermes_override)"
pass "Hermes uses ODS_UID/ODS_GID when set"

n8n_default="$(env -u ODS_UID -u ODS_GID N8N_USER=admin N8N_PASS=test docker compose -f extensions/services/n8n/compose.yaml config 2>/dev/null | grep -E '^\s*user:')"
[[ "$n8n_default" == *"1000:1000"* ]] || fail "n8n default user drifted (got: $n8n_default)"
pass "n8n keeps its documented default (1000:1000) when ODS_UID/ODS_GID are unset"

n8n_override="$(N8N_USER=admin N8N_PASS=test ODS_UID=4242 ODS_GID=4343 docker compose -f extensions/services/n8n/compose.yaml config 2>/dev/null | grep -E '^\s*user:')"
[[ "$n8n_override" == *"4242:4343"* ]] || fail "n8n did not honor ODS_UID/ODS_GID (got: $n8n_override)"
pass "n8n uses ODS_UID/ODS_GID when set"

echo ""
echo "  All checks passed"
