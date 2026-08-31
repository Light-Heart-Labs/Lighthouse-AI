#!/bin/bash
# ============================================================================
# ODS validate-sim-summary.py Test Suite
# ============================================================================
# Ensures scripts/validate-sim-summary.py validates installer simulation
# summaries correctly for both success and failure cases.
#
# Usage: ./tests/test-validate-sim-summary.sh
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

PASSED=0
FAILED=0

pass() { echo -e "  ${GREEN}✓ PASS${NC} $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "  ${RED}✗ FAIL${NC} $1"; FAILED=$((FAILED + 1)); }

echo ""
echo "╔════════════════════════════════════════════════════╗"
echo "║   validate-sim-summary.py Test Suite              ║"
echo "╚════════════════════════════════════════════════════╝"
echo ""

if [[ ! -f "$ROOT_DIR/scripts/validate-sim-summary.py" ]]; then
    fail "scripts/validate-sim-summary.py not found"
    echo ""; echo "Result: $PASSED passed, $FAILED failed"; exit 1
fi
pass "validate-sim-summary.py exists"

python3 -m py_compile "$ROOT_DIR/scripts/validate-sim-summary.py"
pass "validate-sim-summary.py compiles"

set +e
python3 "$ROOT_DIR/scripts/validate-sim-summary.py" --help >/dev/null 2>&1
r=$?
set -e
if [[ $r -eq 0 ]]; then
    pass "--help exits 0"
else
    fail "--help should exit 0, got $r"
fi

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

set +e
python3 "$ROOT_DIR/scripts/validate-sim-summary.py" "$TMP_DIR/missing.json" >/dev/null 2>&1
r=$?
set -e
if [[ $r -eq 2 ]]; then
    pass "missing summary file exits 2"
else
    fail "missing summary file should exit 2, got $r"
fi

printf '{invalid json' > "$TMP_DIR/bad.json"
set +e
python3 "$ROOT_DIR/scripts/validate-sim-summary.py" "$TMP_DIR/bad.json" >/dev/null 2>&1
r=$?
set -e
if [[ $r -eq 3 ]]; then
    pass "invalid JSON exits 3"
else
    fail "invalid JSON should exit 3, got $r"
fi

cat > "$TMP_DIR/valid.json" <<'EOF'
{
  "version": "1",
  "generated_at": "2026-03-15T12:34:56Z",
  "golden_paths": {
    "contract": "config/golden-paths.json",
    "evidence": "artifacts/installer-sim/golden-paths.json",
    "scenario_count": 4,
    "pass_count": 4
  },
  "runs": {
    "linux_dryrun": {
      "exit_code": 0,
      "signals": {
        "capability_loaded": true,
        "hardware_class_logged": true,
        "backend_contract_loaded": true,
        "preflight_report_logged": true,
        "compose_selection_logged": true
      },
      "log": "artifacts/linux-dryrun.log",
      "install_summary": {}
    },
    "macos_installer_mvp": {
      "exit_code": 0,
      "log": "artifacts/macos-installer.log",
      "preflight": null,
      "doctor": null
    },
    "windows_scenario_preflight": {
      "report": {
        "summary": {
          "blockers": 0,
          "warnings": 1
        }
      }
    },
    "doctor_snapshot": {
      "exit_code": 0,
      "report": {
        "autofix_hints": [],
        "summary": {
          "runtime_ready": true
        }
      }
    }
  }
}
EOF

set +e
out=$(python3 "$ROOT_DIR/scripts/validate-sim-summary.py" "$TMP_DIR/valid.json" 2>&1)
r=$?
set -e
if [[ $r -eq 0 ]]; then
    pass "valid summary exits 0"
else
    fail "valid summary should exit 0, got $r"
fi
if echo "$out" | grep -q "\[PASS\]"; then
    pass "valid summary prints PASS marker"
else
    fail "valid summary should print PASS marker"
fi

python3 - <<'PY' "$TMP_DIR/valid.json" "$TMP_DIR/bad-golden-count.json"
import json
import sys
src, dest = sys.argv[1], sys.argv[2]
with open(src, encoding="utf-8") as f:
    data = json.load(f)
data["golden_paths"]["pass_count"] = 5
with open(dest, "w", encoding="utf-8") as f:
    json.dump(data, f)
PY

set +e
out=$(python3 "$ROOT_DIR/scripts/validate-sim-summary.py" "$TMP_DIR/bad-golden-count.json" 2>&1)
r=$?
set -e
if [[ $r -eq 2 ]]; then
    pass "invalid golden path pass count exits 2"
else
    fail "invalid golden path pass count should exit 2, got $r"
fi
if echo "$out" | grep -q "pass_count"; then
    pass "golden path validation error mentions pass_count"
else
    fail "golden path validation error should mention pass_count"
fi

python3 - <<'PY' "$TMP_DIR/valid.json" "$TMP_DIR/missing-signal.json"
import json
import sys
src, dest = sys.argv[1], sys.argv[2]
with open(src, encoding="utf-8") as f:
    data = json.load(f)
del data["runs"]["linux_dryrun"]["signals"]["compose_selection_logged"]
with open(dest, "w", encoding="utf-8") as f:
    json.dump(data, f)
PY

set +e
out=$(python3 "$ROOT_DIR/scripts/validate-sim-summary.py" "$TMP_DIR/missing-signal.json" 2>&1)
r=$?
set -e
if [[ $r -eq 2 ]]; then
    pass "missing nested signal exits 2"
else
    fail "missing nested signal should exit 2, got $r"
fi
if echo "$out" | grep -q "compose_selection_logged"; then
    pass "nested validation error mentions missing signal"
else
    fail "nested validation error should mention missing signal"
fi

assert_invalid_outcome() {
    local fixture="$1"
    local expected_path="$2"
    local description="$3"
    local output
    local status

    set +e
    output=$(python3 "$ROOT_DIR/scripts/validate-sim-summary.py" "$fixture" 2>&1)
    status=$?
    set -e

    if [[ $status -eq 2 ]]; then
        pass "$description exits 2"
    else
        fail "$description should exit 2, got $status"
    fi
    if echo "$output" | grep -q "$expected_path"; then
        pass "$description identifies $expected_path"
    else
        fail "$description should identify $expected_path"
    fi
}

python3 - <<'PY' "$TMP_DIR/valid.json" "$TMP_DIR"
import copy
import json
import pathlib
import sys

source, output_dir = sys.argv[1:]
with open(source, encoding="utf-8") as handle:
    valid = json.load(handle)

fixtures = {}

fixtures["failed-linux-exit.json"] = copy.deepcopy(valid)
fixtures["failed-linux-exit.json"]["runs"]["linux_dryrun"]["exit_code"] = 17

fixtures["missing-linux-signal.json"] = copy.deepcopy(valid)
fixtures["missing-linux-signal.json"]["runs"]["linux_dryrun"]["signals"]["capability_loaded"] = False

fixtures["macos-blocker.json"] = copy.deepcopy(valid)
fixtures["macos-blocker.json"]["runs"]["macos_installer_mvp"]["preflight"] = {
    "summary": {"blockers": 1, "warnings": 0}
}

fixtures["windows-blocker.json"] = copy.deepcopy(valid)
fixtures["windows-blocker.json"]["runs"]["windows_scenario_preflight"]["report"]["summary"]["blockers"] = 1

fixtures["failed-doctor-exit.json"] = copy.deepcopy(valid)
fixtures["failed-doctor-exit.json"]["runs"]["doctor_snapshot"]["exit_code"] = 3

fixtures["incomplete-golden-paths.json"] = copy.deepcopy(valid)
fixtures["incomplete-golden-paths.json"]["golden_paths"]["pass_count"] = 3

for name, data in fixtures.items():
    path = pathlib.Path(output_dir, name)
    path.write_text(json.dumps(data), encoding="utf-8")
PY

assert_invalid_outcome "$TMP_DIR/failed-linux-exit.json" "linux_dryrun.exit_code" "failed Linux simulation"
assert_invalid_outcome "$TMP_DIR/missing-linux-signal.json" "capability_loaded" "false Linux success signal"
assert_invalid_outcome "$TMP_DIR/macos-blocker.json" "macos_installer_mvp.preflight.summary.blockers" "macOS blocker"
assert_invalid_outcome "$TMP_DIR/windows-blocker.json" "windows_scenario_preflight.report.summary.blockers" "Windows blocker"
assert_invalid_outcome "$TMP_DIR/failed-doctor-exit.json" "doctor_snapshot.exit_code" "failed doctor snapshot"
assert_invalid_outcome "$TMP_DIR/incomplete-golden-paths.json" "golden_paths.pass_count" "incomplete golden paths"

python3 - <<'PY' "$TMP_DIR/valid.json" "$TMP_DIR/no-generated-at.json"
import json
import sys
src, dest = sys.argv[1], sys.argv[2]
with open(src, encoding="utf-8") as f:
    data = json.load(f)
data.pop("generated_at", None)
with open(dest, "w", encoding="utf-8") as f:
    json.dump(data, f)
PY

set +e
python3 "$ROOT_DIR/scripts/validate-sim-summary.py" --strict "$TMP_DIR/no-generated-at.json" >/dev/null 2>&1
r=$?
set -e
if [[ $r -eq 2 ]]; then
    pass "strict mode requires generated_at"
else
    fail "strict mode missing generated_at should exit 2, got $r"
fi

echo ""
echo "Result: $PASSED passed, $FAILED failed"
[[ $FAILED -eq 0 ]]
