#!/bin/bash
# ============================================================================
# ODS check-release-claims.sh Test Suite
# ============================================================================
# Ensures scripts/check-release-claims.sh correctly cross-checks
# manifest.json's OS support flags against docs/SUPPORT-MATRIX.md and
# docs/PLATFORM-TRUTH-TABLE.md wording claims.
#
# Usage: ./tests/test-check-release-claims.sh
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CHECK_CLAIMS_BASH="${BASH:-$(command -v bash)}"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

PASSED=0
FAILED=0

pass() { echo -e "  ${GREEN}✓ PASS${NC} $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "  ${RED}✗ FAIL${NC} $1"; FAILED=$((FAILED + 1)); }

echo ""
echo "╔═══════════════════════════════════════════════╗"
echo "║   check-release-claims.sh Test Suite           ║"
echo "╚═══════════════════════════════════════════════╝"
echo ""

if [[ ! -f "$ROOT_DIR/scripts/check-release-claims.sh" ]]; then
    fail "scripts/check-release-claims.sh not found"
    echo ""; echo "Result: $PASSED passed, $FAILED failed"; exit 1
fi
pass "check-release-claims.sh exists"

if ! command -v jq &>/dev/null; then
    fail "jq is required for check-release-claims.sh"
    echo ""; echo "Result: $PASSED passed, $FAILED failed"; exit 1
fi
pass "jq available"

# 1. Real repo state passes end-to-end.
set +e
out=$("$CHECK_CLAIMS_BASH" "$ROOT_DIR/scripts/check-release-claims.sh" 2>&1)
r=$?
set -e
if [[ $r -eq 0 ]]; then
    pass "Real manifest.json/docs validate cleanly"
else
    fail "Real manifest.json/docs should validate cleanly, got exit $r: $out"
fi

# Sandbox: copy the script into a fake ROOT_DIR so its hardcoded paths
# (derived from the script's own location) resolve against a controllable
# manifest.json and docs/ tree instead of the real repo's.
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT
mkdir -p "$TMP_DIR/scripts" "$TMP_DIR/docs"
cp "$ROOT_DIR/scripts/check-release-claims.sh" "$TMP_DIR/scripts/check-release-claims.sh"

write_valid_docs() {
    cat > "$TMP_DIR/docs/SUPPORT-MATRIX.md" <<'EOF'
| Platform | Status |
|---|---|
| Windows (Docker Desktop + WSL2) | Tier B |
| macOS (Apple Silicon) | Tier B |

Run install.ps1 to get started on Windows.
EOF
    cat > "$TMP_DIR/docs/PLATFORM-TRUTH-TABLE.md" <<'EOF'
| Platform | Tier |
|---|---|
| Windows (Docker Desktop + WSL2) | Tier B |
| macOS Apple Silicon | Tier B |

## Not safe to claim now
- Native Windows production support
EOF
}

write_manifest() {
    local linux="$1" wsl="$2" macos="$3" windows_native="$4"
    cat > "$TMP_DIR/manifest.json" <<EOF
{
  "compatibility": {
    "os": {
      "linux": {"supported": $linux},
      "windows_wsl2": {"supported": $wsl},
      "macos": {"supported": $macos},
      "windows_native": {"supported": $windows_native}
    }
  }
}
EOF
}

# 2. Missing manifest.json / docs -> exit 1.
set +e
"$CHECK_CLAIMS_BASH" "$TMP_DIR/scripts/check-release-claims.sh" >/dev/null 2>&1
r=$?
set -e
if [[ $r -eq 1 ]]; then
    pass "Missing manifest.json and docs yield exit 1"
else
    fail "Missing manifest.json and docs should yield exit 1, got $r"
fi

# 3. Valid docs, manifest violates the linux-supported claim -> exit 1.
write_valid_docs
write_manifest false true true false
set +e
out=$("$CHECK_CLAIMS_BASH" "$TMP_DIR/scripts/check-release-claims.sh" 2>&1)
r=$?
set -e
if [[ $r -eq 1 ]] && echo "$out" | grep -q "linux supported"; then
    pass "manifest.json linux.supported=false is rejected"
else
    fail "linux.supported=false should yield exit 1, got $r: $out"
fi

# 4. Valid docs, manifest wrongly marks windows_native supported -> exit 1.
write_manifest true true true true
set +e
out=$("$CHECK_CLAIMS_BASH" "$TMP_DIR/scripts/check-release-claims.sh" 2>&1)
r=$?
set -e
if [[ $r -eq 1 ]] && echo "$out" | grep -q "windows_native unsupported"; then
    pass "manifest.json windows_native.supported=true is rejected"
else
    fail "windows_native.supported=true should yield exit 1, got $r: $out"
fi

# 5. Correct manifest, but SUPPORT-MATRIX.md missing the Windows Tier B claim -> exit 1.
write_manifest true true true false
cat > "$TMP_DIR/docs/SUPPORT-MATRIX.md" <<'EOF'
| Platform | Status |
|---|---|
| macOS (Apple Silicon) | Tier B |

Run install.ps1 to get started on Windows.
EOF
set +e
out=$("$CHECK_CLAIMS_BASH" "$TMP_DIR/scripts/check-release-claims.sh" 2>&1)
r=$?
set -e
if [[ $r -eq 1 ]] && echo "$out" | grep -q "support matrix missing Windows Tier B claim"; then
    pass "Missing Windows Tier B claim in SUPPORT-MATRIX.md is rejected"
else
    fail "Missing Windows Tier B claim should yield exit 1, got $r: $out"
fi

# 6. Correct manifest and matrix, truth table missing the launch-guardrails section -> exit 1.
write_valid_docs
cat > "$TMP_DIR/docs/PLATFORM-TRUTH-TABLE.md" <<'EOF'
| Platform | Tier |
|---|---|
| Windows (Docker Desktop + WSL2) | Tier B |
| macOS Apple Silicon | Tier B |
EOF
set +e
out=$("$CHECK_CLAIMS_BASH" "$TMP_DIR/scripts/check-release-claims.sh" 2>&1)
r=$?
set -e
if [[ $r -eq 1 ]] && echo "$out" | grep -q "launch guardrails section"; then
    pass "Missing launch-guardrails section in truth table is rejected"
else
    fail "Missing launch-guardrails section should yield exit 1, got $r: $out"
fi

# 7. Everything consistent -> exit 0.
write_valid_docs
write_manifest true true true false
set +e
out=$("$CHECK_CLAIMS_BASH" "$TMP_DIR/scripts/check-release-claims.sh" 2>&1)
r=$?
set -e
if [[ $r -eq 0 ]] && echo "$out" | grep -q "release claim gates"; then
    pass "Fully consistent manifest/docs yields exit 0"
else
    fail "Fully consistent manifest/docs should yield exit 0, got $r: $out"
fi

echo ""
echo "Result: $PASSED passed, $FAILED failed"
[[ $FAILED -eq 0 ]]
