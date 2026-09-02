#!/usr/bin/env bash
# Concurrent public-command coverage for isolated doctor artifacts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURE="$(mktemp -d "${TMPDIR:-/tmp}/ods-doctor-concurrency.XXXXXX")"
trap 'rm -rf "$FIXTURE"' EXIT

mkdir -p "$FIXTURE/sync" "$FIXTURE/work" "$FIXTURE/bin"

for command_name in curl docker nvidia-smi; do
    printf '#!/usr/bin/env bash\nexit 1\n' > "$FIXTURE/bin/$command_name"
    chmod +x "$FIXTURE/bin/$command_name"
done

for marker in A B; do
    install_root="$FIXTURE/$marker"
    mkdir -p "$install_root/ods/scripts" "$install_root/ods/lib" "$install_root/ods/extensions/services"
    cp "$ROOT_DIR/scripts/ods-doctor.sh" "$install_root/ods/scripts/ods-doctor.sh"
    cp "$ROOT_DIR/lib/service-registry.sh" "$ROOT_DIR/lib/safe-env.sh" "$install_root/ods/lib/"

    cat > "$install_root/ods/scripts/build-capability-profile.sh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
output=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --output) output="$2"; shift 2 ;;
        *) shift ;;
    esac
done
printf '{"marker":"%s"}\n' "$MARKER" > "$output"
touch "$SYNC_DIR/cap-$MARKER"
for _ in {1..500}; do
    [[ -f "$SYNC_DIR/cap-A" && -f "$SYNC_DIR/cap-B" ]] && break
    sleep 0.01
done
[[ -f "$SYNC_DIR/cap-A" && -f "$SYNC_DIR/cap-B" ]]
printf '%s\n' \
    'CAP_RECOMMENDED_TIER=T1' \
    'CAP_LLM_BACKEND=cpu' \
    'CAP_GPU_VRAM_MB=0' \
    'CAP_GPU_NAME=None' \
    'CAP_PLATFORM_ID=test' \
    'CAP_COMPOSE_OVERLAYS='
STUB

    cat > "$install_root/ods/scripts/preflight-engine.sh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
report=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --report) report="$2"; shift 2 ;;
        *) shift ;;
    esac
done
printf '{"marker":"%s"}\n' "$MARKER" > "$report"
printf '%s\n' 'PREFLIGHT_BLOCKERS=0' 'PREFLIGHT_WARNINGS=0'
STUB
    chmod +x "$install_root/ods/scripts/"*.sh
done

run_doctor() {
    local marker="$1"
    MARKER="$marker" \
    SYNC_DIR="$FIXTURE/sync" \
    TMPDIR="$FIXTURE/work" \
    PATH="$FIXTURE/bin:$PATH" \
        bash "$FIXTURE/$marker/ods/scripts/ods-doctor.sh" \
        "$FIXTURE/report-$marker.json" > "$FIXTURE/output-$marker.log"
}

run_doctor A &
pid_a=$!
run_doctor B &
pid_b=$!
wait "$pid_a"
wait "$pid_b"

python3 - "$FIXTURE/report-A.json" "$FIXTURE/report-B.json" <<'PY'
import json
import sys

for marker, path in zip(("A", "B"), sys.argv[1:]):
    report = json.load(open(path, encoding="utf-8"))
    assert report["capability_profile"]["marker"] == marker
PY

if find "$FIXTURE/work" -mindepth 1 -print -quit | grep . >/dev/null; then
    echo "doctor left private intermediate files behind" >&2
    exit 1
fi

echo "Concurrent doctor reports remain isolated"
