#!/usr/bin/env bash
# Public preflight regression for exact LLM container identity.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURE="$(mktemp -d "${TMPDIR:-/tmp}/ods-preflight-container.XXXXXX")"
trap 'rm -rf "$FIXTURE"' EXIT

mkdir -p "$FIXTURE/lib" "$FIXTURE/bin"
cp "$ROOT_DIR/ods-preflight.sh" "$FIXTURE/ods-preflight.sh"
cp "$ROOT_DIR/lib/safe-env.sh" "$FIXTURE/lib/safe-env.sh"

cat > "$FIXTURE/bin/docker" <<'STUB'
#!/usr/bin/env bash
case "${1:-} ${2:-}" in
    '--version ')
        echo 'Docker version 27.0.0, build test'
        ;;
    'info ')
        echo 'Server: test'
        ;;
    'compose version')
        echo 'Docker Compose version v2.27.0'
        ;;
    'port ods-llama-server')
        exit 1
        ;;
    'ps --format')
        echo 'ods-llama-server-debug'
        ;;
    *)
        exit 1
        ;;
esac
STUB

cat > "$FIXTURE/bin/curl" <<'STUB'
#!/usr/bin/env bash
exit 1
STUB

cat > "$FIXTURE/bin/nvidia-smi" <<'STUB'
#!/usr/bin/env bash
exit 1
STUB
chmod +x "$FIXTURE/bin/"*

set +e
output=$(PATH="$FIXTURE/bin:$PATH" GPU_BACKEND=cpu bash "$FIXTURE/ods-preflight.sh" 2>&1)
status=$?
set -e

[[ "$status" -eq 1 ]] || {
    echo "expected failing preflight with offline services, got $status" >&2
    exit 1
}
grep -F 'No LLM endpoint found' <<< "$output" >/dev/null || {
    echo "preflight treated a similarly named container as the LLM" >&2
    exit 1
}
if grep -F 'container running but not responding yet' <<< "$output" >/dev/null; then
    echo "preflight reported the debug container as the managed LLM" >&2
    exit 1
fi

echo "Preflight requires the exact managed LLM container name"
