#!/usr/bin/env bash
# Regression: upsert_env_value() (installers/macos/lib/env-generator.sh and
# installers/macos/ods-macos.sh — duplicated implementations) interpolated
# the raw value into a sed replacement with no escaping. A value containing
# '&' (sed's "whole match" token — common in OAuth-style URLs with query
# strings, e.g. RAG_OPENAI_API_BASE_URL) silently duplicated the matched
# line into the .env file instead of replacing it; a value containing '|'
# (the chosen sed delimiter) broke the sed expression outright, aborting
# the caller under set -euo pipefail.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
PASSED=0
FAILED=0
pass() { printf "  ${GREEN}✓ PASS${NC} %s\n" "$1"; PASSED=$((PASSED + 1)); }
fail() { printf "  ${RED}✗ FAIL${NC} %s\n" "$1"; FAILED=$((FAILED + 1)); }

echo ""
echo "=== upsert_env_value sed-escaping tests ==="
echo ""

check_source() {
    local target="$1" label="$2"

    # Extract just upsert_env_value so nothing else in the file runs.
    local src
    src="$(sed -n '/^upsert_env_value()/,/^}/p' "$target")"
    if [[ -z "$src" ]]; then
        fail "$label: could not extract upsert_env_value"
        return
    fi
    eval "$src"

    # This function's `sed -i ''` is BSD sed syntax — correct (and the only
    # option) on real macOS, where these scripts actually run, but GNU sed
    # (this CI runner) parses `-i ''` differently. Shim it locally so the
    # test exercises the function's actual escaping logic instead of
    # failing on an unrelated platform difference in sed's -i flag.
    if sed --version 2>/dev/null | grep -q GNU; then
        sed() {
            if [[ "${1:-}" == "-i" && "${2-unset}" == "" ]]; then
                shift 2
                command sed -i "$@"
            else
                command sed "$@"
            fi
        }
    fi

    local tmp
    tmp="$(mktemp -d)"

    # Value containing '&' must not duplicate the line.
    printf 'RAG_OPENAI_API_BASE_URL=http://embeddings:80/v1\n' > "$tmp/env"
    upsert_env_value "$tmp/env" "RAG_OPENAI_API_BASE_URL" \
        "https://api.example.com/v1?api-version=2024&region=us"
    local ampersand_result
    ampersand_result="$(grep '^RAG_OPENAI_API_BASE_URL=' "$tmp/env")"
    if [[ "$ampersand_result" == "RAG_OPENAI_API_BASE_URL=https://api.example.com/v1?api-version=2024&region=us" ]]; then
        pass "$label: value containing '&' round-trips without duplicating the line"
    else
        fail "$label: value containing '&' corrupted the line (got: $ampersand_result)"
    fi
    [[ "$(wc -l < "$tmp/env" | tr -d ' ')" == "1" ]] \
        && pass "$label: '&' value does not inject an extra line" \
        || fail "$label: '&' value injected an extra line"

    # Value containing '|' (the sed delimiter) must not break the expression.
    printf 'TARGET_API_KEY=old\n' > "$tmp/env2"
    if upsert_env_value "$tmp/env2" "TARGET_API_KEY" "sk-abc|def" 2>"$tmp/err"; then
        local pipe_result
        pipe_result="$(grep '^TARGET_API_KEY=' "$tmp/env2")"
        if [[ "$pipe_result" == "TARGET_API_KEY=sk-abc|def" ]]; then
            pass "$label: value containing '|' round-trips without breaking sed"
        else
            fail "$label: value containing '|' produced wrong content (got: $pipe_result)"
        fi
    else
        fail "$label: value containing '|' broke the sed expression: $(cat "$tmp/err")"
    fi

    rm -rf "$tmp"
}

check_source "$ROOT_DIR/installers/macos/lib/env-generator.sh" "env-generator.sh"
check_source "$ROOT_DIR/installers/macos/ods-macos.sh" "ods-macos.sh"

echo ""
echo "Result: $PASSED passed, $FAILED failed"
echo ""
[[ $FAILED -eq 0 ]]
