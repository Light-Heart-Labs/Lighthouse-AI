#!/usr/bin/env bash
# Public CLI regression: failed publication preserves the previous report.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PREFLIGHT="$ROOT_DIR/scripts/linux-install-preflight.sh"
FIXTURE="$(mktemp -d "${TMPDIR:-/tmp}/ods-linux-preflight-report.XXXXXX")"
trap 'rm -rf "$FIXTURE"' EXIT

mkdir -p "$FIXTURE/bin"
cat > "$FIXTURE/bin/mv" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MV_CALLS"
exit 42
STUB
chmod +x "$FIXTURE/bin/mv"

report="$FIXTURE/report.json"
printf '%s\n' '{"generation":"known-good"}' > "$report"

set +e
MV_CALLS="$FIXTURE/mv.log" PATH="$FIXTURE/bin:$PATH" \
    bash "$PREFLIGHT" --json-file "$report" > "$FIXTURE/stdout.log" 2> "$FIXTURE/stderr.log"
status=$?
set -e

[[ "$status" -ne 0 ]] || {
    echo "preflight reported success after publication failed" >&2
    exit 1
}
[[ -s "$FIXTURE/mv.log" ]] || {
    echo "preflight did not use atomic replacement" >&2
    exit 1
}
[[ "$(cat "$report")" == '{"generation":"known-good"}' ]] || {
    echo "failed publication replaced the known-good report" >&2
    exit 1
}
if find "$FIXTURE" -maxdepth 1 -name '.report.json.*' -print -quit | grep . >/dev/null; then
    echo "failed publication left a temporary report behind" >&2
    exit 1
fi

echo "Linux preflight preserves its previous report on publish failure"
