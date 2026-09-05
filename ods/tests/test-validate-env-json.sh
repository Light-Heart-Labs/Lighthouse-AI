#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VALIDATOR="$ROOT_DIR/scripts/validate-env.sh"
FIXTURE="$(mktemp -d "${TMPDIR:-/tmp}/ods-env-json.XXXXXX")"
trap 'rm -rf "$FIXTURE"' EXIT

cat > "$FIXTURE/schema.json" <<'JSON'
{
  "type": "object",
  "required": ["SECRET", "COUNT", "MISSING"],
  "properties": {
    "SECRET": {"type": "string", "minLength": 3, "secret": true},
    "COUNT": {"type": "integer"},
    "MISSING": {"type": "string"}
  }
}
JSON

cat > "$FIXTURE/invalid.env" <<'ENV'
SECRET=first-secret-value
COUNT=not-a-number
EXTRA=value
SECRET=second-secret-value
ENV

set +e
invalid_json="$(bash "$VALIDATOR" --json "$FIXTURE/invalid.env" "$FIXTURE/schema.json")"
invalid_status=$?
set -e
[[ $invalid_status -eq 2 ]]
[[ "$invalid_json" != *"first-secret-value"* ]]
[[ "$invalid_json" != *"second-secret-value"* ]]
JSON_REPORT="$invalid_json" python3 - <<'PY'
import json
import os

report = json.loads(os.environ["JSON_REPORT"])
assert report["schema_version"] == "1"
assert report["kind"] == "env-validation"
assert report["valid"] is False
assert report["error_code"] == "validation_failed"
assert report["errors"]["missing_required"] == ["MISSING"]
assert report["errors"]["unknown_keys"] == ["EXTRA"]
assert len(report["errors"]["type"]) == 1
assert "COUNT" in report["errors"]["type"][0]
assert len(report["errors"]["duplicate"]) == 1
assert "SECRET" in report["errors"]["duplicate"][0]
assert report["summary"] == {
    "env_keys": 3,
    "schema_keys": 3,
    "required_keys": 3,
    "secret_keys": 1,
    "total_errors": 4,
    "total_warnings": 0,
}
PY

cat > "$FIXTURE/valid.env" <<'ENV'
SECRET=valid-secret-value
COUNT=7
MISSING=present
ENV
valid_json="$(bash "$VALIDATOR" "$FIXTURE/valid.env" --json "$FIXTURE/schema.json")"
JSON_REPORT="$valid_json" python3 - <<'PY'
import json
import os

report = json.loads(os.environ["JSON_REPORT"])
assert report["valid"] is True
assert report["error_code"] == ""
assert report["summary"]["total_errors"] == 0
assert all(not values for values in report["errors"].values())
PY

set +e
missing_json="$(bash "$VALIDATOR" --json "$FIXTURE/no.env" "$FIXTURE/schema.json")"
missing_status=$?
set -e
[[ $missing_status -eq 3 ]]
JSON_REPORT="$missing_json" python3 - <<'PY'
import json
import os

report = json.loads(os.environ["JSON_REPORT"])
assert report["valid"] is False
assert report["error_code"] == "env_file_unreadable"
PY

echo "Environment validation JSON tests passed"
