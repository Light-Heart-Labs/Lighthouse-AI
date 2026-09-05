#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHEPHERD="$ROOT_DIR/memory-shepherd/memory-shepherd.sh"
TEST_ROOT="$(mktemp -d -t memory-shepherd-remote-XXXXXX)"
agent="remote-test-$$"
legacy_tmp="/tmp/memory-shepherd-${agent}-current.md"
trap 'rm -f "$legacy_tmp"; rm -rf "$TEST_ROOT"' EXIT

mkdir -p "$TEST_ROOT/bin" "$TEST_ROOT/tmp" "$TEST_ROOT/baselines"
{
    printf '# Baseline\n'
    for _ in {1..80}; do
        printf 'Durable baseline content.\n'
    done
} > "$TEST_ROOT/baselines/agent.md"
printf '# Remote memory\n---\nprivate remote scratch\n' > "$TEST_ROOT/remote-memory.md"
printf 'must not be overwritten\n' > "$TEST_ROOT/victim"
ln -s "$TEST_ROOT/victim" "$legacy_tmp"

config="$TEST_ROOT/memory-shepherd.conf"
printf '%s\n' \
    '[general]' \
    "baseline_dir=$TEST_ROOT/baselines" \
    "archive_dir=$TEST_ROOT/archives" \
    'min_baseline_size=500' \
    "[$agent]" \
    'remote_host=example.invalid' \
    'remote_user=tester' \
    'remote_memory=/srv/MEMORY.md' \
    'baseline=agent.md' \
    > "$config"

printf '%s\n' '#!/usr/bin/env bash' \
    'set -euo pipefail' \
    '[[ "${1:-}" == "-q" ]] && shift' \
    'if [[ "$1" == *:* ]]; then' \
    '    cp "$ODS_TEST_REMOTE_MEMORY" "$2"' \
    '    printf "%s\n" "$2" > "$ODS_TEST_FETCH_PATH"' \
    '    exit 0' \
    'fi' \
    'exit 73' \
    > "$TEST_ROOT/bin/scp"
chmod +x "$TEST_ROOT/bin/scp"

if HOME="$TEST_ROOT/home" \
    TMPDIR="$TEST_ROOT/tmp" \
    PATH="$TEST_ROOT/bin:$PATH" \
    MEMORY_SHEPHERD_CONF="$config" \
    ODS_TEST_REMOTE_MEMORY="$TEST_ROOT/remote-memory.md" \
    ODS_TEST_FETCH_PATH="$TEST_ROOT/fetch-path" \
    bash "$SHEPHERD" "$agent" > "$TEST_ROOT/output" 2>&1; then
    echo "expected the mocked remote upload to fail" >&2
    exit 1
fi

fetch_path="$(cat "$TEST_ROOT/fetch-path")"
[[ "$fetch_path" == "$TEST_ROOT/tmp/memory-shepherd-${agent}."* ]]
[[ ! -e "$fetch_path" ]]
[[ "$(cat "$TEST_ROOT/victim")" == "must not be overwritten" ]]
[[ -L "$legacy_tmp" ]]

echo "memory shepherd remote tempfile tests passed"
