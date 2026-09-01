#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TOOL="$ROOT_DIR/scripts/llm-cold-storage.sh"
FIXTURE="$(mktemp -d "${TMPDIR:-/tmp}/ods-cold-status.XXXXXX")"
trap 'rm -rf "$FIXTURE"' EXIT

cache="$FIXTURE/cache"
cold="$FIXTURE/cold"
mkdir -p "$cache/models--Example--Hot" "$cold/models--Example--Archived"
printf 'hot\n' > "$cache/models--Example--Hot/weights.gguf"
printf 'cold\n' > "$cold/models--Example--Archived/weights.gguf"
ln -s "$cold/models--Example--Archived" "$cache/models--Example--Archived"

json_out="$(
    HF_CACHE="$cache" COLD_DIR="$cold" LOG_FILE="$FIXTURE/tool.log" \
        bash "$TOOL" --json --status
)"
JSON_REPORT="$json_out" CACHE_PATH="$cache" COLD_PATH="$cold" python3 - <<'PY'
import json
import os

report = json.loads(os.environ["JSON_REPORT"])
assert report["schema_version"] == "1"
assert report["kind"] == "llm-cold-storage-status"
assert report["paths"] == {
    "cache": os.environ["CACHE_PATH"],
    "cold_storage": os.environ["COLD_PATH"],
}
assert report["summary"]["hot"] == 1
assert report["summary"]["cold_links"] == 1
assert report["summary"]["cold"] == 1
states = {(item["name"], item["state"]) for item in report["models"]}
assert states == {
    ("models--Example--Hot", "hot"),
    ("models--Example--Archived", "cold_link"),
    ("models--Example--Archived", "cold"),
}
hot = next(item for item in report["models"] if item["state"] == "hot")
assert isinstance(hot["idle_days"], int)
assert hot["protected"] is False
assert hot["in_use"] is False
PY

set +e
error_out="$(HF_CACHE="$cache" COLD_DIR="$cold" LOG_FILE="$FIXTURE/tool.log" bash "$TOOL" --json 2>&1)"
status=$?
set -e
[[ $status -eq 2 ]]
[[ "$error_out" == *"supported only with --status"* ]]

echo "LLM cold-storage JSON tests passed"
