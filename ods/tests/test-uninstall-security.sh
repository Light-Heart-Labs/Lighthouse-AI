#!/bin/bash
# tests/test-uninstall-security.sh - Regression test for ODS uninstall security leak
# Verifies that no passwords or sensitive sudo-piping patterns are used.

set -euo pipefail

SCRIPT_UNDER_TEST="ods/ods-uninstall.sh"

if [[ ! -f "$SCRIPT_UNDER_TEST" ]]; then
    echo "Error: $SCRIPT_UNDER_TEST not found"
    exit 1
fi

echo "Checking for insecure sudo patterns in $SCRIPT_UNDER_TEST..."

# 1. Check for password piping to sudo (e.g., echo password | sudo -S)
if grep -E "echo .*\|.*sudo -S" "$SCRIPT_UNDER_TEST"; then
    echo "FAILED: Found password piping to sudo -S"
    exit 1
fi

# 2. Check for sudo -S without piping (still risky if passed via env)
if grep -q "sudo -S" "$SCRIPT_UNDER_TEST"; then
    echo "FAILED: Found sudo -S usage"
    exit 1
fi

# 3. Check for passing passwords as arguments to sudo
if grep -E "sudo .*--password" "$SCRIPT_UNDER_TEST"; then
    echo "FAILED: Found sudo password arguments"
    exit 1
fi

# 4. Verify that sudo -v is used to cache credentials
if ! grep -q "sudo -v" "$SCRIPT_UNDER_TEST"; then
    echo "FAILED: sudo -v (credential caching) not found"
    exit 1
fi

echo "SUCCESS: No known security leaks in sudo invocation found."
exit 0
