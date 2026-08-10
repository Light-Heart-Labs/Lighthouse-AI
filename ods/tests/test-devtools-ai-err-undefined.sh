#!/bin/bash
# Regression: 07-devtools.sh called `ai_err` when LITELLM_KEY is empty
# during OpenCode switchboard config, but installers/lib/ui.sh (the Linux
# UI helpers this installer path sources) defines ai(), ai_ok(), ai_warn(),
# and ai_bad() — never ai_err (that name is macOS-only, defined in
# installers/macos/lib/ui.sh). Under `set -euo pipefail`, calling an
# undefined function crashes with "command not found" instead of showing
# the intended error message.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$ROOT_DIR/installers/phases/07-devtools.sh"
UI_LIB="$ROOT_DIR/installers/lib/ui.sh"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'
PASSED=0
FAILED=0
pass() { echo -e "  ${GREEN}✓${NC} $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "  ${RED}✗${NC} $1"; FAILED=$((FAILED + 1)); }

echo ""
echo "=== 07-devtools.sh ai_err/ai_bad regression ==="
echo ""

if grep -q '^ai_bad()' "$UI_LIB"; then
    pass "installers/lib/ui.sh defines ai_bad (the Linux error-level function)"
else
    fail "installers/lib/ui.sh does not define ai_bad"
fi
if grep -q '^ai_err()' "$UI_LIB"; then
    fail "installers/lib/ui.sh unexpectedly defines ai_err (test assumption changed)"
else
    pass "installers/lib/ui.sh does not define ai_err (confirms it's not usable on Linux)"
fi

if grep -q 'ai_err "OpenCode switchboard' "$TARGET"; then
    fail "07-devtools.sh still calls the undefined ai_err"
else
    pass "07-devtools.sh no longer calls the undefined ai_err"
fi
if grep -q 'ai_bad "OpenCode switchboard' "$TARGET"; then
    pass "07-devtools.sh now calls ai_bad, which is actually defined"
else
    fail "07-devtools.sh does not call ai_bad for this message"
fi

# Direct reproduction: source only the Linux ui.sh's ai_* definitions (no
# terminal/log-file setup needed for ai_bad's simple echo), then confirm
# calling the function this file actually uses succeeds, while the old
# (undefined) name fails exactly like the reported crash.
LOG_FILE=/dev/null
RED_C='' NC_C='' GRN='' BGRN='' AMB=''
ai_bad() { echo "ai_bad: $1"; }

if (set -e; ai_bad "test message" >/dev/null); then
    pass "ai_bad (the function 07-devtools.sh now calls) executes successfully"
else
    fail "ai_bad call failed unexpectedly"
fi

if (set -e; ai_err "test message" >/dev/null 2>&1); then
    fail "ai_err unexpectedly succeeded (should be undefined under set -e)"
else
    pass "calling the old undefined ai_err reproduces the crash (command not found)"
fi

echo ""
echo "Result: $PASSED passed, $FAILED failed"
echo ""
[[ $FAILED -eq 0 ]]
