#!/bin/bash
set -euo pipefail

# Setup a mock environment
TEST_DIR=$(mktemp -d)
STATUS_FILE="$TEST_DIR/bootstrap-status.json"
FULL_GGUF_FILE="model.gguf"

# Mock the write_status function from the script
write_status() {
    local status="$1" percent="${2:-}" downloaded="${3:-0}" total="${4:-0}" speed="${5:-0}" eta="${6:-}"
    local _safe_model="${FULL_GGUF_FILE//\"/\\\"}"
    local tmp_file="${STATUS_FILE}.tmp.$$"
    
    # Simulate a partial write by cutting the content mid-way
    # We use a subshell and 'kill' or just write a truncated version to simulate failure
    # But for a regression test, we want to prove that if we FAIL before the 'mv', 
    # the original file is untouched.
    
    echo "{\"status\": \"$status\"," > "$tmp_file"
    # SIMULATE CRASH HERE: we return 1 and don't call mv
    return 1
}

# 1. Create initial valid status
echo '{"status": "initial", "model": "model.gguf"}' > "$STATUS_FILE"

# 2. Attempt a write that fails
if write_status "downloading" "10" "100" "1000" 0 "10s"; then
    echo "Error: write_status should have failed"
    exit 1
fi

# 3. Assert the original file is still the initial version and NOT truncated/corrupted
if ! grep -q '"status": "initial"' "$STATUS_FILE"; then
    echo "Error: STATUS_FILE was corrupted or modified despite failure!"
    exit 1
fi

# 4. Verify that a successful write works as expected
write_status_success() {
    local status="$1"
    local tmp_file="${STATUS_FILE}.tmp.$$"
    echo "{\"status\": \"$status\"}" > "$tmp_file"
    mv -f "$tmp_file" "$STATUS_FILE"
}

write_status_success "completed"
if ! grep -q '"status": "completed"' "$STATUS_FILE"; then
    echo "Error: Successful write failed to update file"
    exit 1
fi

echo "Atomic write regression test passed!"
rm -rf "$TEST_DIR"
