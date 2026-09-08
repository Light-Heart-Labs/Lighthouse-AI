#!/usr/bin/env bash
# ============================================================================
# Test: scripts/ods-test.sh completes the run and emits one JSON document
# ============================================================================
# Regression: the suite runs under `set -euo pipefail`, and a failed probe used
# to escape as a non-zero status four ways — a section's `return 1`, a bare
# test_http/test_tcp call, a `[[ c ]] && log "..."` guard (log() returned 1
# whenever --verbose was off, and the list returns 1 when the condition is
# false), and an unguarded `var=$(curl ...)` capture. Any one of them aborted
# the run at the first failing check, so the summary never printed and --json
# produced a truncated, unparseable document.
#
# The script is exercised end-to-end against a fixture install whose every port
# is closed, which is the state of any machine where the stack is not up yet.
#
# Usage: bash tests/test-ods-test-full-run.sh
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ODS_TEST="$SCRIPT_DIR/scripts/ods-test.sh"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

PASSED=0
FAILED=0
pass() { echo -e "${GREEN}✓${NC} $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "${RED}✗${NC} $1"; FAILED=$((FAILED + 1)); }
info() { echo -e "${BLUE}ℹ${NC} $1"; }

[[ -f "$ODS_TEST" ]] || { echo "scripts/ods-test.sh not found"; exit 1; }

if ! command -v python3 >/dev/null 2>&1; then
    echo "SKIP: python3 required to parse the --json document"
    exit 0
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/ods-test-full-run.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# Fixture install: the script sources lib/safe-env.sh for load_env_file, and
# lib/service-registry.sh only when present. Omitting the registry keeps the
# fixture free of the Bash 4 requirement that file imposes; port resolution
# then falls through to the env overrides set below.
FAKE="$TMP/ods"
mkdir -p "$FAKE/lib" "$FAKE/scripts"
cp "$SCRIPT_DIR/lib/safe-env.sh" "$FAKE/lib/"
cp "$ODS_TEST" "$FAKE/scripts/"
: > "$FAKE/.env"

# Ports nothing listens on, so every probe fails the way a not-yet-started
# stack does. High and fixed so a stray listener is implausible.
run_suite() {
    ODS_DIR="$FAKE" \
    ENV_FILE="$FAKE/.env" \
    LLM_HOST=127.0.0.1        LLM_PORT=59401 \
    WHISPER_HOST=127.0.0.1    WHISPER_PORT=59402 \
    TTS_HOST=127.0.0.1        TTS_PORT=59403 \
    EMBEDDING_HOST=127.0.0.1  EMBEDDING_PORT=59404 \
    LIVEKIT_HOST=127.0.0.1    LIVEKIT_PORT=59405 \
    PRIVACY_SHIELD_PORT=59406 \
    bash "$FAKE/scripts/ods-test.sh" "$@"
}

# Sections that only run after the LLM check fails. Before the fix the run
# aborted there, so their absence is the regression this test exists for.
LATE_SECTIONS=(
    "Whisper Speech-to-Text"
    "Kokoro TTS Text-to-Speech"
    "Embeddings TEI"
    "Privacy Shield M3"
    "LiveKit Voice Infrastructure"
)
LATE_RESULTS=(
    "Whisper Port"
    "TTS Port"
    "Embeddings Port"
    "Privacy Shield Health"
    "LiveKit Port"
)

# ---------------------------------------------------------------------------
info "Text mode reaches the summary with every section run"
# ---------------------------------------------------------------------------
text_exit=0
run_suite > "$TMP/text.out" 2>"$TMP/text.err" || text_exit=$?

if [[ $text_exit -eq 1 ]]; then
    pass "text mode exits 1 when checks fail (documented contract)"
else
    fail "text mode should exit 1, got $text_exit"
    sed -n '1,40p' "$TMP/text.out"
fi

if grep -q "SOME TESTS FAILED" "$TMP/text.out"; then
    pass "text mode prints the summary"
else
    fail "text mode never printed the summary (run aborted early)"
fi

missing_section=""
for section in "${LATE_SECTIONS[@]}"; do
    grep -qF "> $section" "$TMP/text.out" || missing_section="$section"
done
if [[ -z "$missing_section" ]]; then
    pass "text mode runs every section after the first failure"
else
    fail "text mode never reached section: $missing_section"
fi

# ---------------------------------------------------------------------------
info "--json emits exactly one parseable document covering every section"
# ---------------------------------------------------------------------------
json_exit=0
run_suite --json > "$TMP/out.json" 2>"$TMP/json.err" || json_exit=$?

if [[ $json_exit -eq 1 ]]; then
    pass "--json exits 1 when checks fail"
else
    fail "--json should exit 1, got $json_exit"
fi

if grep -q '^> ' "$TMP/out.json"; then
    fail "--json wrote section banners to stdout (document is not pure JSON)"
else
    pass "--json keeps section banners off stdout"
fi

if python3 - "$TMP/out.json" "${LATE_RESULTS[@]}" <<'PY'
import json
import sys

path, expected = sys.argv[1], sys.argv[2:]
with open(path, encoding="utf-8") as handle:
    doc = json.load(handle)

names = {r["name"] for r in doc["results"]}
missing = [n for n in expected if n not in names]
if missing:
    print(f"missing from --json results: {missing}", file=sys.stderr)
    raise SystemExit(1)

summary = doc["summary"]
if summary["total"] != len(doc["results"]):
    print(f"summary.total {summary['total']} != {len(doc['results'])} results", file=sys.stderr)
    raise SystemExit(1)
if summary["failed"] <= 0 or summary["success"] is not False:
    print(f"expected failures with success=false, got {summary}", file=sys.stderr)
    raise SystemExit(1)
PY
then
    pass "--json is one valid document with the later sections and a consistent summary"
else
    fail "--json document invalid or truncated"
    echo "--- stdout ---"; sed -n '1,25p' "$TMP/out.json"
fi

# ---------------------------------------------------------------------------
info "--json --quick also completes"
# ---------------------------------------------------------------------------
quick_exit=0
run_suite --json --quick > "$TMP/quick.json" 2>/dev/null || quick_exit=$?
if [[ $quick_exit -eq 1 ]] && python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$TMP/quick.json" 2>/dev/null; then
    pass "--json --quick emits a valid document and exits 1"
else
    fail "--json --quick did not emit a valid document (exit $quick_exit)"
fi

# ---------------------------------------------------------------------------
info "Every --service target reaches its summary"
# ---------------------------------------------------------------------------
bad_service=""
for service in docker gpu llm tool-calling whisper tts embeddings \
               voice-roundtrip privacy-shield livekit; do
    svc_exit=0
    run_suite --service "$service" > "$TMP/svc.out" 2>/dev/null || svc_exit=$?
    if [[ $svc_exit -gt 1 ]]; then
        bad_service="$service (exit $svc_exit)"
    elif ! grep -qE "TESTS (PASSED|FAILED)" "$TMP/svc.out"; then
        bad_service="$service (no summary)"
    fi
done
if [[ -z "$bad_service" ]]; then
    pass "all --service targets complete and print a summary"
else
    fail "--service target did not complete: $bad_service"
fi

# ---------------------------------------------------------------------------
info "log() succeeds when --verbose is off"
# ---------------------------------------------------------------------------
# log() is the tail of `[[ c ]] && log "..."` guards. Returning non-zero there
# aborts the section under set -e, so assert the contract directly.
if bash -c "
    set -euo pipefail
    VERBOSE=false
    $(sed -n '/^log() {/,/^}/p' "$ODS_TEST")
    log 'quiet'
    echo reached
" 2>/dev/null | grep -q reached; then
    pass "log() returns 0 when VERBOSE=false"
else
    fail "log() returns non-zero when VERBOSE=false (aborts sections under set -e)"
fi

echo ""
echo "Passed: $PASSED  Failed: $FAILED"
[[ $FAILED -eq 0 ]]
