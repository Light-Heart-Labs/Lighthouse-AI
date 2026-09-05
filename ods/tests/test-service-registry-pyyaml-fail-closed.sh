#!/usr/bin/env bash
# sr_load must fail closed when PyYAML is missing (not return 0 with an empty registry).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
PASS=0
FAIL=0
pass() { echo -e "  ${GREEN}PASS${NC} $1"; PASS=$((PASS + 1)); }
fail() { echo -e "  ${RED}FAIL${NC} $1"; FAIL=$((FAIL + 1)); }

echo ""
echo "=== service registry PyYAML fail-closed ==="
echo ""

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/python3" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == *import\ yaml* ]] || [[ "$*" == *'import yaml'* ]]; then
  echo "No module named yaml" >&2
  exit 1
fi
exit 1
EOF
chmod +x "$TMP/python3"
# Also shadow `python` so sr_load cannot fall through to a YAML-capable interpreter.
cp "$TMP/python3" "$TMP/python"
chmod +x "$TMP/python"

export PATH="$TMP:$PATH"
export SCRIPT_DIR="$TMP"
# Empty SCRIPT_DIR lib so python-cmd.sh is not sourced.
mkdir -p "$TMP/lib"

# shellcheck source=../lib/service-registry.sh
. "$PROJECT_DIR/lib/service-registry.sh"

_SR_LOADED=false
_SR_FAILED=false
set +e
sr_load
rc=$?
set -e

if [[ "$rc" -ne 0 ]]; then
    pass "sr_load exits nonzero without PyYAML"
else
    fail "sr_load returned 0 without PyYAML"
fi
if [[ "$_SR_FAILED" == "true" ]]; then
    pass "_SR_FAILED is set"
else
    fail "_SR_FAILED was not set"
fi
if [[ "$_SR_LOADED" != "true" ]]; then
    pass "_SR_LOADED stays false so a later pip install can retry"
else
    fail "_SR_LOADED was set true (would skip retry)"
fi

echo ""
echo "Result: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
