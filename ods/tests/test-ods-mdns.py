#!/bin/bash
# Test: ods-mdns.py socket resource management
# Bug #1: Improved socket handling using context manager

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MDNS_SCRIPT="$SCRIPT_DIR/../bin/ods-mdns.py"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

pass() { echo -e "${GREEN}✓${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; exit 1; }
info() { echo -e "${BLUE}ℹ${NC} $1"; }

[[ -f "$MDNS_SCRIPT" ]] || fail "ods-mdns.py not found"

# Test 1: Verify _get_local_ip uses context manager (with statement)
info "Test 1: Verify socket uses context manager"
if grep -q "with socket.socket" "$MDNS_SCRIPT"; then
    pass "Socket uses 'with' context manager"
else
    fail "Socket does not use context manager"
fi

# Test 2: Verify no explicit close() call (should be managed by context manager)
info "Test 2: Verify no manual close() in _get_local_ip"
if grep -A 25 "def _get_local_ip" "$MDNS_SCRIPT" | grep -q ".close()"; then
    fail "Found manual .close() - context manager should handle cleanup"
else
    pass "No manual close() - context manager handles cleanup"
fi

# Test 3: Verify OSError exception is caught
info "Test 3: Verify OSError exception handling"
if grep -A 15 "def _get_local_ip" "$MDNS_SCRIPT" | grep -q "except OSError"; then
    pass "OSError exception properly caught"
else
    fail "OSError not caught"
fi

# Test 4: Verify fallback IP is returned
info "Test 4: Verify fallback to 127.0.0.1"
if grep -A 25 "def _get_local_ip" "$MDNS_SCRIPT" | grep -q '127.0.0.1'; then
    pass "Fallback to 127.0.0.1 on error"
else
    fail "No fallback IP defined"
fi

# Test 5: Verify return statement is in try block (early return on success)
info "Test 5: Verify early return on success"
if grep -A 12 "with socket.socket" "$MDNS_SCRIPT" | grep -q "return s.getsockname"; then
    pass "Early return on successful IP detection"
else
    fail "No early return on success"
fi

echo ""
echo "All ods-mdns socket handling tests passed"
