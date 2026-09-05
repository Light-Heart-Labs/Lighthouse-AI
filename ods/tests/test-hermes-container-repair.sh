#!/usr/bin/env bash
# Regression: every platform CLI can replace a Hermes container mutated by the
# in-app updater and prove that the proxy reaches the restored runtime.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root_dir="$(cd "$script_dir/.." && pwd)"
tmp_dir="$(mktemp -d)"
install_dir="$tmp_dir/install"
bin_dir="$tmp_dir/bin"
docker_log="$tmp_dir/docker.log"
trap 'rm -rf "$tmp_dir"' EXIT

mkdir -p "$install_dir/data" "$bin_dir"
cp "$root_dir/docker-compose.base.yml" "$install_dir/docker-compose.base.yml"
printf '%s\n' '-f docker-compose.base.yml' > "$install_dir/.compose-flags"

printf '%s\n' \
    'ODS_VERSION=2.6.0' \
    'ODS_MODE=local' \
    'GPU_BACKEND=apple' \
    'GPU_COUNT=1' \
    'TIER=1' \
    'LLAMA_CPU_LIMIT=8.0' \
    'LLAMA_CPU_RESERVATION=2.0' \
    'HERMES_CPU_LIMIT=4.0' \
    'HERMES_CPU_RESERVATION=0.5' \
    > "$install_dir/.env"

apply_test_docker() {
    printf '%s\n' '#!/usr/bin/env bash' \
        'set -euo pipefail' \
        'printf '\''%s\n'\'' "$*" >> "${TEST_DOCKER_LOG:?}"' \
        'if [[ "${1:-}" == "info" || "${1:-}" == "ps" ]]; then exit 0; fi' \
        'if [[ "${1:-}" == "compose" && " $* " == *" config --services "* ]]; then' \
        '    printf '\''%s\n'\'' hermes hermes-proxy' \
        '    exit 0' \
        'fi' \
        'if [[ "${1:-}" == "compose" && " $* " == *" up -d --no-deps --force-recreate --pull never hermes hermes-proxy "* ]]; then exit 0; fi' \
        'if [[ "${1:-}" == "inspect" && "${*: -1}" == "ods-hermes" ]]; then printf '\''healthy\n'\''; exit 0; fi' \
        'if [[ "$*" == "exec ods-hermes-proxy wget -qO- -T 5 http://ods-hermes:9119/api/status" ]]; then' \
        '    [[ "${TEST_PROXY_FAIL:-0}" == "1" ]] && exit 22' \
        '    exit 0' \
        'fi' \
        'printf '\''unexpected docker invocation: %s\n'\'' "$*" >&2' \
        'exit 1' \
        > "$bin_dir/docker"
    chmod +x "$bin_dir/docker"
}

apply_test_docker

run_repair() {
    local name="$1"
    local cli="$2"
    local output="$tmp_dir/${name}.out"
    : > "$docker_log"

    PATH="$bin_dir:$PATH" \
    ODS_HOME="$install_dir" \
    NO_COLOR=1 \
    TEST_DOCKER_LOG="$docker_log" \
        "$BASH" "$cli" repair hermes > "$output" 2>&1 || {
            sed -n '1,200p' "$output" >&2
            return 1
        }

    grep -q 'Hermes container recovery complete' "$output" || {
        sed -n '1,200p' "$output" >&2
        printf '[FAIL] %s CLI did not report verified Hermes recovery\n' "$name" >&2
        return 1
    }
    grep -Eq 'compose .*docker-compose.base.yml up -d --no-deps --force-recreate --pull never hermes hermes-proxy' "$docker_log" || {
        sed -n '1,200p' "$docker_log" >&2
        printf '[FAIL] %s CLI did not recreate only the pinned Hermes services\n' "$name" >&2
        return 1
    }
    grep -q 'inspect --format .* ods-hermes' "$docker_log" || {
        sed -n '1,200p' "$docker_log" >&2
        printf '[FAIL] %s CLI did not wait for the restored Hermes healthcheck\n' "$name" >&2
        return 1
    }
    grep -q 'exec ods-hermes-proxy wget -qO- -T 5 http://ods-hermes:9119/api/status' "$docker_log" || {
        sed -n '1,200p' "$docker_log" >&2
        printf '[FAIL] %s CLI did not verify the proxy-to-Hermes path\n' "$name" >&2
        return 1
    }
}

run_repair linux "$root_dir/ods-cli"
run_repair macos "$root_dir/installers/macos/ods-macos.sh"

failure_output="$tmp_dir/proxy-failure.out"
if PATH="$bin_dir:$PATH" \
    ODS_HOME="$install_dir" \
    NO_COLOR=1 \
    TEST_DOCKER_LOG="$docker_log" \
    TEST_PROXY_FAIL=1 \
        "$BASH" "$root_dir/ods-cli" repair hermes > "$failure_output" 2>&1; then
    printf '[FAIL] Linux CLI reported success when the Hermes proxy could not reach its upstream\n' >&2
    exit 1
fi
grep -q 'proxy cannot reach the restored runtime' "$failure_output" || {
    sed -n '1,200p' "$failure_output" >&2
    printf '[FAIL] Linux CLI did not explain the failed proxy verification\n' >&2
    exit 1
}
if grep -q 'Hermes container recovery complete' "$failure_output"; then
    printf '[FAIL] Linux CLI emitted a success receipt after failed proxy verification\n' >&2
    exit 1
fi

windows_cli="$root_dir/installers/windows/ods.ps1"
grep -q '^function Invoke-RepairHermes' "$windows_cli" || {
    printf '[FAIL] Windows CLI does not expose Hermes container recovery\n' >&2
    exit 1
}
grep -q '"up", "-d", "--no-deps", "--force-recreate", "--pull", "never", "hermes", "hermes-proxy"' "$windows_cli" || {
    printf '[FAIL] Windows recovery does not use the pinned, dependency-isolated Compose contract\n' >&2
    exit 1
}
grep -q 'http://ods-hermes:9119/api/status' "$windows_cli" || {
    printf '[FAIL] Windows recovery does not verify the internal proxy route\n' >&2
    exit 1
}

printf '[PASS] Hermes container recovery is verified across platform CLIs\n'
