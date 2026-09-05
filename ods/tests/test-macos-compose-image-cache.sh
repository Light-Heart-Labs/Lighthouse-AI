#!/usr/bin/env bash
# Behavioral coverage for the macOS Compose image cache preflight.

if [ "${BASH_VERSINFO[0]:-0}" -lt 4 ]; then
    for candidate in /opt/homebrew/bin/bash /usr/local/bin/bash; do
        [[ -x "$candidate" ]] && exec "$candidate" "$0" "$@"
    done
    echo "[FAIL] Bash 4+ is required" >&2
    exit 1
fi

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER="$ROOT_DIR/installers/macos/install-macos.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
    echo "[FAIL] $*" >&2
    exit 1
}

pass() {
    echo "[PASS] $*"
}

extract_installer_function() {
    awk -v function_name="$1" '
        $0 ~ "^[[:space:]]*" function_name "\\(\\) \\{" {
            capture = 1
        }
        capture {
            print
        }
        capture && $0 ~ "^    \\}$" {
            exit
        }
    ' "$INSTALLER"
}

for function_name in \
    _macos_is_local_image \
    _macos_compose_external_images \
    _macos_normalize_image_platform \
    _macos_cached_image_platform \
    _macos_pull_error_is_permanent \
    _macos_pull_image_with_retry \
    _macos_pre_pull_compose_images; do
    function_body="$(extract_installer_function "$function_name")"
    [[ -n "$function_body" ]] || fail "could not extract $function_name"
    eval "$function_body"
done

export ODS_LOG_FILE="$TMP_DIR/install.log"
export ODS_DOCKER_PULL_MAX_ATTEMPTS=2
# Used by the installer function loaded with eval below.
# shellcheck disable=SC2034
COMPOSE_FLAGS=()
MOCK_DOCKER_CALLS="$TMP_DIR/docker-calls.log"
MOCK_INSPECT_EXIT=1
MOCK_INSPECT_OUTPUT=""
MOCK_PULL_EXIT=0
MOCK_PULL_STDERR=""
MOCK_COMPOSE_JSON=""
MOCK_COMPOSE_CONFIG_EXIT=0

ai() { :; }
ai_ok() { :; }
ai_warn() { :; }
ai_err() { :; }
log() { :; }
sleep() { :; }

docker() {
    printf '%s\n' "$*" >> "$MOCK_DOCKER_CALLS"
    if [[ "$1" == "image" && "$2" == "inspect" ]]; then
        [[ "$MOCK_INSPECT_EXIT" -eq 0 ]] || return "$MOCK_INSPECT_EXIT"
        printf '%s\n' "$MOCK_INSPECT_OUTPUT"
        return 0
    fi
    if [[ "$1" == "pull" ]]; then
        [[ -n "$MOCK_PULL_STDERR" ]] && printf '%s\n' "$MOCK_PULL_STDERR" >&2
        return "$MOCK_PULL_EXIT"
    fi
    if [[ "$1" == "compose" && "$*" == *"config --format json"* ]]; then
        [[ "$MOCK_COMPOSE_CONFIG_EXIT" -eq 0 ]] || return "$MOCK_COMPOSE_CONFIG_EXIT"
        printf '%s\n' "$MOCK_COMPOSE_JSON"
        return 0
    fi
    fail "unexpected docker invocation: $*"
}

reset_docker_mock() {
    : > "$MOCK_DOCKER_CALLS"
    MOCK_INSPECT_EXIT=1
    MOCK_INSPECT_OUTPUT=""
    MOCK_PULL_EXIT=0
    MOCK_PULL_STDERR=""
    MOCK_COMPOSE_CONFIG_EXIT=0
}

assert_call_count() {
    local pattern="$1" expected="$2" actual
    actual="$(grep -c -- "$pattern" "$MOCK_DOCKER_CALLS" || true)"
    [[ "$actual" == "$expected" ]] \
        || fail "expected $expected calls matching '$pattern', got $actual"
}

assert_normalized() {
    local input="$1" expected="$2" actual
    actual="$(_macos_normalize_image_platform "$input")" \
        || fail "could not normalize platform '$input'"
    [[ "$actual" == "$expected" ]] \
        || fail "platform '$input' normalized to '$actual', expected '$expected'"
}

assert_normalized "linux/amd64" "linux/amd64"
assert_normalized "AMD64" "linux/amd64"
assert_normalized "linux/x86_64" "linux/amd64"
assert_normalized "linux/arm64" "linux/arm64"
assert_normalized "aarch64" "linux/arm64"
assert_normalized '"linux/arm64/v8"' "linux/arm64"
if _macos_normalize_image_platform "linux/arm/v7" >/dev/null 2>&1; then
    fail "unsupported architecture unexpectedly normalized"
fi
pass "platform aliases and inspect output variants normalize safely"

MOCK_COMPOSE_JSON='{
  "services": {
    "tei": {"image": "ghcr.io/example/tei:latest", "platform": "linux/amd64"},
    "cache": {"image": "redis:7"},
    "local": {"image": "ods-dashboard-api:latest"},
    "built": {"image": "ignored:latest", "build": {"context": "."}}
  }
}'
compose_images="$(_macos_compose_external_images)"
expected_pinned=$'ghcr.io/example/tei:latest\tlinux/amd64'
expected_unpinned=$'redis:7\t'
grep -Fqx "$expected_pinned" <<< "$compose_images" \
    || fail "compose platform pin was not preserved"
grep -Fqx "$expected_unpinned" <<< "$compose_images" \
    || fail "unpinned compose image was not preserved"
[[ "$compose_images" != *"ods-dashboard-api"* && "$compose_images" != *"ignored:latest"* ]] \
    || fail "local or built image leaked into external pre-pull set"
pass "Compose JSON parsing preserves platform pins and filters local builds"

# Regression: the resolver used to fall back to `config --images`, which has no
# platform column. That silently degraded every pinned image to a host-arch pull
# and made text-embeddings-inference unpullable on Apple Silicon. Unresolvable
# compose config must now be a hard failure, never a platform-blind image list.
reset_docker_mock
MOCK_COMPOSE_CONFIG_EXIT=1
if compose_images="$(_macos_compose_external_images)"; then
    fail "unresolvable compose config did not fail the image resolver"
fi
[[ -z "${compose_images:-}" ]] || fail "failed resolver still emitted images: $compose_images"
assert_call_count "config --images" 0
MOCK_COMPOSE_CONFIG_EXIT=0
pass "unresolvable compose config fails loudly instead of dropping platform pins"

manifest_error_log="$TMP_DIR/manifest-error.log"
printf '%s\n' \
    'no matching manifest for linux/arm64/v8 in the manifest list entries: no match for platform in manifest: not found' \
    > "$manifest_error_log"
_macos_pull_error_is_permanent "$manifest_error_log" \
    || fail "missing arm64 manifest was not classified as permanent"
printf '%s\n' 'error pulling image: net/http: TLS handshake timeout' > "$manifest_error_log"
if _macos_pull_error_is_permanent "$manifest_error_log"; then
    fail "transient network error was misclassified as permanent"
fi
pass "permanent manifest errors are distinguished from transient pull failures"

reset_docker_mock
MOCK_PULL_EXIT=1
MOCK_PULL_STDERR='no matching manifest for linux/arm64/v8 in the manifest list entries: no match for platform in manifest: not found'
if _macos_pull_image_with_retry "ghcr.io/example/tei:latest" "linux/amd64"; then
    fail "unpullable manifest unexpectedly reported success"
fi
assert_call_count "^pull --platform linux/amd64 ghcr.io/example/tei:latest$" 1
pass "missing manifest aborts on the first attempt instead of burning the retry budget"

reset_docker_mock
_macos_pull_image_with_retry "ghcr.io/example/tei:latest" "linux/amd64" \
    || fail "absent cache did not pull the requested platform"
assert_call_count "^image inspect " 1
assert_call_count "^pull --platform linux/amd64 ghcr.io/example/tei:latest$" 1
pass "absent cache pulls the pinned platform"

reset_docker_mock
MOCK_INSPECT_EXIT=0
MOCK_INSPECT_OUTPUT="linux/amd64"
MOCK_PULL_EXIT=1
_macos_pull_image_with_retry "ghcr.io/example/tei:latest" "linux/amd64" \
    || fail "matching cached image was not accepted"
assert_call_count "^image inspect " 1
assert_call_count "^pull " 0
pass "matching cached image is reused without registry access"

reset_docker_mock
MOCK_INSPECT_EXIT=0
MOCK_INSPECT_OUTPUT="linux/arm64"
_macos_pull_image_with_retry "ghcr.io/example/tei:latest" "linux/amd64" \
    || fail "mismatched cache was not remediated"
assert_call_count "^pull --platform linux/amd64 ghcr.io/example/tei:latest$" 1
pass "mismatched cached architecture is replaced by a pinned pull"

reset_docker_mock
MOCK_INSPECT_EXIT=0
MOCK_INSPECT_OUTPUT='"linux/aarch64/v8"'
MOCK_PULL_EXIT=1
_macos_pull_image_with_retry "ghcr.io/example/arm-service:latest" "linux/arm64" \
    || fail "matching arm64 cache was not accepted while offline"
assert_call_count "^pull " 0
pass "offline rerun succeeds with a normalized matching cache"

reset_docker_mock
MOCK_INSPECT_EXIT=0
MOCK_INSPECT_OUTPUT="linux/arm64"
MOCK_PULL_EXIT=1
if _macos_pull_image_with_retry "ghcr.io/example/tei:latest" "linux/amd64"; then
    fail "mismatched cache unexpectedly passed after pull failures"
fi
assert_call_count "^pull --platform linux/amd64 ghcr.io/example/tei:latest$" 2
pass "pull failure remains fatal when the cached platform is wrong"

# End-to-end wiring for the real Apple Silicon failure in #3257: the embeddings
# extension pins text-embeddings-inference to linux/amd64 because the image has
# no arm64 manifest. The preflight must carry that pin all the way from
# `compose config` into the docker pull argv.
reset_docker_mock
# Used by the installer function loaded with eval below.
# shellcheck disable=SC2034
INSTALL_DIR="$TMP_DIR"
MOCK_COMPOSE_JSON='{
  "services": {
    "embeddings": {
      "image": "ghcr.io/huggingface/text-embeddings-inference:cpu-1.9.1",
      "platform": "linux/amd64"
    },
    "open-webui": {"image": "ghcr.io/open-webui/open-webui:main"}
  }
}'
_macos_pre_pull_compose_images \
    || fail "preflight failed for a healthy platform-pinned stack"
assert_call_count \
    "^pull --platform linux/amd64 ghcr.io/huggingface/text-embeddings-inference:cpu-1.9.1$" 1
assert_call_count "^pull ghcr.io/open-webui/open-webui:main$" 1
assert_call_count "^pull ghcr.io/huggingface/text-embeddings-inference:cpu-1.9.1$" 0
pass "preflight carries the compose platform pin into docker pull for TEI"

echo "[OK] macOS Compose image cache preflight passed"
