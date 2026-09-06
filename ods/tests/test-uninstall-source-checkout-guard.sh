#!/bin/bash
# Tests that ods-uninstall.sh safely aborts when run from a source checkout
# instead of deleting the developer's working tree.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNINSTALLER="$REPO_ROOT/ods-uninstall.sh"

echo "Running uninstall source-checkout guard test..."

if [[ ! -f "$UNINSTALLER" ]]; then
    echo "FAIL: Could not find $UNINSTALLER"
    exit 1
fi

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

cd "$TMP_DIR"

# 1. Simulate a git checkout containing the uninstaller and ods-cli marker
git init -q
mkdir ods
cp "$UNINSTALLER" ods/
touch ods/ods-cli

# 2. Execute the uninstaller with --force
set +e
OUTPUT=$(./ods/ods-uninstall.sh --force 2>&1)
EXIT_CODE=$?
set -e

# 3. Assertions
if [[ $EXIT_CODE -ne 1 ]]; then
    echo "FAIL: Expected uninstaller to exit with code 1, got $EXIT_CODE"
    echo "Output was:"
    echo "$OUTPUT"
    exit 1
fi

if ! echo "$OUTPUT" | grep -q "Safety abort"; then
    echo "FAIL: Safety abort message not found in output."
    echo "Output was:"
    echo "$OUTPUT"
    exit 1
fi

if [[ ! -d "ods" ]]; then
    echo "FAIL: The uninstaller deleted the source directory anyway!"
    exit 1
fi

echo "PASS: Uninstaller refused to delete the source checkout."