#!/bin/bash
# Tests that ods-preflight.sh fails gracefully with an actionable error
# when the installation directory is not writable.

set -euo pipefail

# Locate the root of the repo
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFLIGHT_SCRIPT="$REPO_ROOT/ods-preflight.sh"

echo "Running preflight unwritable log test..."

if [[ ! -f "$PREFLIGHT_SCRIPT" ]]; then
    echo "FAIL: Could not find $PREFLIGHT_SCRIPT"
    exit 1
fi

# Create a secure temp directory
TMP_DIR=$(mktemp -d)
# Ensure we can delete the folder on exit even if we made it read-only
trap 'chmod -R 777 "$TMP_DIR" 2>/dev/null; rm -rf "$TMP_DIR"' EXIT

# Copy the script and stub required dependencies
cp "$PREFLIGHT_SCRIPT" "$TMP_DIR/"
mkdir -p "$TMP_DIR/lib"
touch "$TMP_DIR/lib/safe-env.sh"
touch "$TMP_DIR/.env"

# Remove write permissions from the directory
chmod 555 "$TMP_DIR"

# Run the copied preflight script and capture stderr/stdout
set +e
OUTPUT=$("$TMP_DIR/ods-preflight.sh" 2>&1)
EXIT_CODE=$?
set -e

# Assertions
if [[ $EXIT_CODE -ne 1 ]]; then
    echo "FAIL: Expected preflight to exit with code 1, got $EXIT_CODE"
    echo "Output was:"
    echo "$OUTPUT"
    exit 1
fi

if ! echo "$OUTPUT" | grep -q "Cannot write to log file"; then
    echo "FAIL: Actionable error message not found in output."
    echo "Output was:"
    echo "$OUTPUT"
    exit 1
fi

echo "PASS: Preflight gracefully caught the unwritable directory."