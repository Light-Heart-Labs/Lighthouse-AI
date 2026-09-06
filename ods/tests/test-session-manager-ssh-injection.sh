#!/bin/bash
# Tests that extensions/services/token-spy/session-manager.sh securely handles
# malicious session file names over SSH without command injection.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANAGER_SCRIPT="$REPO_ROOT/extensions/services/token-spy/session-manager.sh"

echo "Running token-spy SSH command injection test..."

if [[ ! -f "$MANAGER_SCRIPT" ]]; then
    echo "FAIL: Could not find $MANAGER_SCRIPT"
    exit 1
fi

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

# 1. Create a fake SSH binary to intercept the calls
mkdir -p "$TMP_DIR/bin"
cat << 'EOF' > "$TMP_DIR/bin/ssh"
#!/bin/bash
# Extract the last argument (the remote command)
command="${*: -1}"

if [[ "$command" == "bash" ]]; then
    # Phase 1: Info gathering. We return a fake oversized session with a malicious name
    echo "SESSION_LIST_START"
    echo 'evil_session; echo pwned|9999999|0'
    echo "SESSION_LIST_END"
    echo "TOTAL_SIZE=9999999"
elif [[ "$command" == "xargs -0 rm -f" ]]; then
    # Phase 2 (Fixed): Deletion. Capture the null-delimited stream from stdin
    cat > "$TMP_DIR_ENV/ssh_rm_input.bin"
else
    # Phase 2 (Vulnerable): The old script passed a flat string directly to rm
    echo "$command" > "$TMP_DIR_ENV/ssh_vuln_input.txt"
fi
EOF
chmod +x "$TMP_DIR/bin/ssh"

# 2. Inject our mock agents into a copy of the script
TEST_SCRIPT="$TMP_DIR/session-manager.sh"
# Insert mock variables right after the set -euo pipefail line
awk '/^set -euo pipefail/ {
    print
    print "AGENTS=()"
    print "REMOTE_AGENTS=(\"mock-agent|mock-host|/mock/dir\")"
    next
} 1' "$MANAGER_SCRIPT" > "$TEST_SCRIPT"

# 3. Execute the script with our fake SSH in the PATH
export PATH="$TMP_DIR/bin:$PATH"
export TMP_DIR_ENV="$TMP_DIR"

bash "$TEST_SCRIPT" >/dev/null 2>&1 || true

# 4. Assertions
if [[ -f "$TMP_DIR/ssh_vuln_input.txt" ]]; then
    echo "FAIL: Script executed vulnerable flat string SSH command:"
    cat "$TMP_DIR/ssh_vuln_input.txt"
    exit 1
fi

if [[ ! -f "$TMP_DIR/ssh_rm_input.bin" ]]; then
    echo "FAIL: Did not capture xargs -0 rm input. Is the fix applied?"
    exit 1
fi

# Convert null bytes to newlines to read the captured payload safely
CAPTURED=$(tr '\0' '\n' < "$TMP_DIR/ssh_rm_input.bin")

# Verify the exact malicious path was passed as a single literal string
EXPECTED="/mock/dir/evil_session; echo pwned.jsonl"
if [[ "$CAPTURED" != *"$EXPECTED"* ]]; then
    echo "FAIL: Captured input does not match expected payload."
    echo "Got: $CAPTURED"
    exit 1
fi

echo "PASS: SSH command injection mitigated successfully."