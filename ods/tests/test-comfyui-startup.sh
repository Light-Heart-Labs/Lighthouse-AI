#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STARTUP="$ROOT_DIR/extensions/services/comfyui/startup.sh"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

fail() {
    printf '[FAIL] %s\n' "$*" >&2
    exit 1
}

fake_bin="$TEMP_DIR/bin"
mkdir -p "$fake_bin"
cat > "$fake_bin/python3" <<'PYTHON'
#!/usr/bin/env bash
if [[ "${1:-}" == "-c" ]]; then
    exit 0
fi
printf '%s\n' "$*" > "$COMFYUI_TEST_LAUNCH_RECEIPT"
PYTHON
chmod +x "$fake_bin/python3"
cat > "$fake_bin/cp" <<'COPY'
#!/usr/bin/env bash
if [[ "${COMFYUI_TEST_FAIL_COPY:-0}" == "1" ]]; then
    printf 'injected workflow copy failure\n' >&2
    exit 73
fi
exec /bin/cp "$@"
COPY
chmod +x "$fake_bin/cp"

prepare_case() {
    local case_dir="$1"
    mkdir -p \
        "$case_dir/comfyui/models" \
        "$case_dir/models" \
        "$case_dir/output" \
        "$case_dir/input" \
        "$case_dir/workflows"
}

run_startup() {
    local case_dir="$1"
    env \
        PATH="$fake_bin:$PATH" \
        ODS_COMFYUI_DIR="$case_dir/comfyui" \
        ODS_COMFYUI_MODELS_MOUNT="$case_dir/models" \
        ODS_COMFYUI_OUTPUT_MOUNT="$case_dir/output" \
        ODS_COMFYUI_INPUT_MOUNT="$case_dir/input" \
        ODS_COMFYUI_WORKFLOWS_MOUNT="$case_dir/workflows" \
        COMFYUI_TEST_LAUNCH_RECEIPT="$case_dir/launch.txt" \
        COMFYUI_TEST_FAIL_COPY="${COMFYUI_TEST_FAIL_COPY:-0}" \
        bash "$STARTUP"
}

success_case="$TEMP_DIR/success"
prepare_case "$success_case"
printf '{"workflow":"ready"}\n' > "$success_case/workflows/example.json"
success_output="$(run_startup "$success_case")"
[[ -f "$success_case/comfyui/user/default/workflows/example.json" ]] \
    || fail "workflow template was not copied"
grep -qF '[startup] Copied workflow templates' <<<"$success_output" \
    || fail "successful copy did not emit its receipt"
grep -qF 'main.py --listen 0.0.0.0 --port 8188' "$success_case/launch.txt" \
    || fail "ComfyUI was not launched after successful setup"

failure_case="$TEMP_DIR/failure"
prepare_case "$failure_case"
printf '{"workflow":"blocked"}\n' > "$failure_case/workflows/blocked.json"
if COMFYUI_TEST_FAIL_COPY=1 run_startup "$failure_case" \
    >"$failure_case/stdout" 2>"$failure_case/stderr"; then
    fail "workflow copy failure was ignored"
fi
[[ ! -e "$failure_case/launch.txt" ]] \
    || fail "ComfyUI launched after an incomplete workflow copy"
[[ ! -s "$failure_case/stdout" ]] \
    || ! grep -qF '[startup] Copied workflow templates' "$failure_case/stdout" \
    || fail "failed copy emitted a false success receipt"

empty_case="$TEMP_DIR/no-json"
prepare_case "$empty_case"
printf 'not a workflow\n' > "$empty_case/workflows/README.txt"
empty_output="$(run_startup "$empty_case")"
if grep -qF '[startup] Copied workflow templates' <<<"$empty_output"; then
    fail "a mount without JSON templates emitted a copy receipt"
fi
[[ -f "$empty_case/launch.txt" ]] \
    || fail "a mount without templates prevented ComfyUI startup"

printf 'ComfyUI startup workflow tests passed\n'
