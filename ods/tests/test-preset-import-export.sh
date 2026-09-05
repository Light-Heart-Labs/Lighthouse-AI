#!/bin/bash
# Test suite for preset import/export functionality
# Validates export and import commands work correctly

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ODS_CLI="$SCRIPT_DIR/../ods-cli"
ODS_ROOT="$SCRIPT_DIR/.."
TEST_DIR="$(mktemp -d)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Test counters
PASSED=0
FAILED=0

# Cleanup on exit
cleanup() {
    rm -rf "$TEST_DIR"
}
trap cleanup EXIT

# Test helpers
pass() {
    echo -e "${GREEN}✓${NC} $1"
    ((PASSED++))
}

fail() {
    echo -e "${RED}✗${NC} $1"
    ((FAILED++))
}

info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

# Print one `case` arm of ods-cli, from its pattern line to the `;;` that ends
# it. Every assertion below is about what a command's implementation does, and
# a fixed `grep -A<N>` window answers a different question: whether a line
# happens to sit within N lines of the pattern. Adding a statement to a command
# pushes later statements out of the window and turns a correct implementation
# into a failing assertion.
case_body() {
    awk -v pat="$1" '
        {
            line = $0
            sub(/^[[:space:]]+/, "", line)
            sub(/[[:space:]]+$/, "", line)
        }
        !inside && line == pat { inside = 1; next }
        inside && line == ";;" { exit }
        inside { print }
    ' "$ODS_CLI"
}

make_install_fixture() {
    local name="$1"
    local install_dir="$TEST_DIR/$name/install"

    mkdir -p \
        "$install_dir/extensions/services" \
        "$install_dir/lib" \
        "$install_dir/presets"
    cp "$ODS_CLI" "$install_dir/ods-cli"
    cp "$ODS_ROOT/lib/service-registry.sh" "$install_dir/lib/"
    cp "$ODS_ROOT/lib/python-cmd.sh" "$install_dir/lib/"
    printf 'services: {}\n' > "$install_dir/docker-compose.base.yml"
    printf '%s\n' "$install_dir"
}

write_valid_preset() {
    local preset_dir="$1"
    local marker="${2:-archive}"

    mkdir -p "$preset_dir"
    printf 'created=2026-08-24T00:00:00Z\n' > "$preset_dir/meta.txt"
    printf 'enabled:dashboard\n' > "$preset_dir/extensions.list"
    printf '%s\n' "$marker" > "$preset_dir/marker.txt"
}

# Test 1: Verify ods-cli syntax
test_syntax() {
    info "Test 1: Validating ods-cli syntax"
    if bash -n "$ODS_CLI" 2>/dev/null; then
        pass "ods-cli syntax is valid"
    else
        fail "ods-cli has syntax errors"
    fi
}

# Test 2: Verify export command exists in help
test_export_in_help() {
    info "Test 2: Checking if 'export' appears in preset help"
    if grep -q "preset export" "$ODS_CLI" 2>/dev/null; then
        pass "'preset export' command documented"
        return 0
    else
        fail "'preset export' command not documented"
        return 0
    fi
}

# Test 3: Verify import command exists in help
test_import_in_help() {
    info "Test 3: Checking if 'import' appears in preset help"
    if grep -q "preset import" "$ODS_CLI" 2>/dev/null; then
        pass "'preset import' command documented"
        return 0
    else
        fail "'preset import' command not documented"
        return 0
    fi
}

# Test 4: Verify export case exists
test_export_case() {
    info "Test 4: Checking if 'export' case exists in cmd_preset"
    if case_body "export|e)" | grep -q "preset export"; then
        pass "'export' case exists in cmd_preset"
        return 0
    else
        fail "'export' case missing from cmd_preset"
        return 0
    fi
}

# Test 5: Verify import case exists
test_import_case() {
    info "Test 5: Checking if 'import' case exists in cmd_preset"
    if case_body "import|i)" | grep -q "preset import"; then
        pass "'import' case exists in cmd_preset"
        return 0
    else
        fail "'import' case missing from cmd_preset"
        return 0
    fi
}

# Test 6: Verify export uses tar
test_export_uses_tar() {
    info "Test 6: Checking if export uses tar for archiving"
    if case_body "export|e)" | grep -q "tar czf"; then
        pass "Export uses tar for archiving"
        return 0
    else
        fail "Export does not use tar"
        return 0
    fi
}

# Test 7: Verify import validates path traversal
test_import_security() {
    info "Test 7: Checking if import validates against path traversal"
    if case_body "import|i)" | grep -q '_import_preset_archive "$archive"' \
        && grep -q 'path.is_absolute()' "$ODS_CLI"; then
        pass "Import checks for path traversal attacks"
        return 0
    else
        fail "Import missing path traversal validation"
        return 0
    fi
}

# Test 8: Verify export validates preset exists
test_export_validation() {
    info "Test 8: Checking if export validates preset exists"
    if case_body "export|e)" | grep -q "Preset not found"; then
        pass "Export validates preset existence"
        return 0
    else
        fail "Export missing preset validation"
        return 0
    fi
}

# Test 9: Verify import validates archive structure
test_import_validation() {
    info "Test 9: Checking if import validates archive structure"
    if case_body "import|i)" | grep -q '_import_preset_archive "$archive"' \
        && grep -q 'staged_preset/meta.txt' "$ODS_CLI" \
        && grep -q 'staged_preset/extensions.list' "$ODS_CLI"; then
        pass "Import validates archive structure"
        return 0
    else
        fail "Import missing structure validation"
        return 0
    fi
}

# Test 10: Verify export creates relative paths
test_export_relative_paths() {
    info "Test 10: Checking if export avoids absolute paths"
    if case_body "export|e)" | grep -q 'cd "$PRESETS_DIR"'; then
        pass "Export creates relative paths"
        return 0
    else
        fail "Export may create absolute paths"
        return 0
    fi
}

# Test 11: Verify import handles overwrite confirmation
test_import_overwrite() {
    info "Test 11: Checking if import handles existing presets"
    if case_body "import|i)" | grep -q '_import_preset_archive "$archive"' \
        && grep -q 'Overwrite? \[y/N\]' "$ODS_CLI"; then
        pass "Import handles overwrite confirmation"
        return 0
    else
        fail "Import missing overwrite handling"
        return 0
    fi
}

# Test 12: Verify usage messages updated
test_usage_updated() {
    info "Test 12: Checking if usage message includes export/import"
    if grep "preset.*export.*import" "$ODS_CLI" 2>/dev/null; then
        pass "Usage message includes export/import"
        return 0
    else
        fail "Usage message not updated"
        return 0
    fi
}

# Test 13: one archive must not be able to mutate a different preset root.
test_import_rejects_multiple_roots_without_mutation() {
    info "Test 13: Rejecting multi-root archives before preset mutation"
    local fixture install_dir archive_src archive before output
    fixture="$TEST_DIR/multi-root"
    install_dir=$(make_install_fixture "multi-root")
    archive_src="$fixture/archive"
    archive="$fixture/multi-root.tar.gz"
    output="$fixture/output.log"

    write_valid_preset "$archive_src/good"
    mkdir -p "$archive_src/victim" "$install_dir/presets/victim"
    printf 'archive replacement\n' > "$archive_src/victim/marker.txt"
    printf 'operator data\n' > "$install_dir/presets/victim/marker.txt"
    before="$fixture/victim-marker.before"
    cp "$install_dir/presets/victim/marker.txt" "$before"
    tar -czf "$archive" -C "$archive_src" good victim

    if ODS_HOME="$install_dir" bash "$install_dir/ods-cli" preset import "$archive" >"$output" 2>&1; then
        fail "Import accepted an archive with multiple preset roots"
        return 0
    fi

    if ! cmp -s "$before" "$install_dir/presets/victim/marker.txt" \
        || [[ -e "$install_dir/presets/good" ]]; then
        fail "Rejected multi-root archive mutated the preset store"
        return 0
    fi

    pass "Multi-root archive is rejected without touching any preset"
}

# Test 14: validation must happen before an existing preset is replaced.
test_import_preserves_existing_preset_on_validation_failure() {
    info "Test 14: Preserving an existing preset when validation fails"
    local fixture install_dir archive_src archive before output
    fixture="$TEST_DIR/invalid-overwrite"
    install_dir=$(make_install_fixture "invalid-overwrite")
    archive_src="$fixture/archive"
    archive="$fixture/replace.tar.gz"
    output="$fixture/output.log"

    write_valid_preset "$install_dir/presets/replace" "operator data"
    mkdir -p "$archive_src/replace"
    printf 'enabled:dashboard\n' > "$archive_src/replace/extensions.list"
    printf 'archive replacement\n' > "$archive_src/replace/marker.txt"
    before="$fixture/replace-marker.before"
    cp "$install_dir/presets/replace/marker.txt" "$before"
    tar -czf "$archive" -C "$archive_src" replace

    if printf 'y\n' | ODS_HOME="$install_dir" bash "$install_dir/ods-cli" preset import "$archive" >"$output" 2>&1; then
        fail "Import accepted a preset with no meta.txt"
        return 0
    fi

    if ! cmp -s "$before" "$install_dir/presets/replace/marker.txt"; then
        fail "Invalid replacement destroyed the existing preset"
        return 0
    fi

    pass "Invalid replacement leaves the existing preset byte-identical"
}

# Test 15: checking a relative path before changing directory must not make the
# later extraction resolve that same path from a different working directory.
test_import_accepts_relative_archive_path() {
    info "Test 15: Importing a valid archive through a relative path"
    local fixture install_dir archive_src output
    fixture="$TEST_DIR/relative-path"
    install_dir=$(make_install_fixture "relative-path")
    archive_src="$fixture/archive"
    output="$fixture/output.log"

    write_valid_preset "$archive_src/portable"
    tar -czf "$fixture/portable.tar.gz" -C "$archive_src" portable

    if ! (
        cd "$fixture"
        ODS_HOME="$install_dir" bash "$install_dir/ods-cli" preset import portable.tar.gz >"$output" 2>&1
    ); then
        fail "Valid relative archive path could not be imported"
        return 0
    fi

    if [[ ! -f "$install_dir/presets/portable/meta.txt" || ! -f "$install_dir/presets/portable/extensions.list" ]]; then
        fail "Relative archive import did not publish the validated preset"
        return 0
    fi

    pass "Valid relative archive imports successfully"
}

# Test 16: links are unnecessary for preset data and can make later reads
# escape the imported preset directory.
test_import_rejects_links() {
    info "Test 16: Rejecting archives that contain links"
    local fixture install_dir archive_src archive output
    fixture="$TEST_DIR/link-entry"
    install_dir=$(make_install_fixture "link-entry")
    archive_src="$fixture/archive"
    archive="$fixture/link.tar.gz"
    output="$fixture/output.log"

    write_valid_preset "$archive_src/linked"
    ln -s /etc/passwd "$archive_src/linked/external"
    tar -czf "$archive" -C "$archive_src" linked

    if ODS_HOME="$install_dir" bash "$install_dir/ods-cli" preset import "$archive" >"$output" 2>&1; then
        fail "Import accepted an archive containing a symbolic link"
        return 0
    fi
    if [[ -e "$install_dir/presets/linked" || -L "$install_dir/presets/linked" ]]; then
        fail "Rejected link archive published a partial preset"
        return 0
    fi

    pass "Link-bearing archive is rejected before publication"
}

# Test 17: the successful overwrite path must publish the fully validated
# staged tree, not merge archive contents into the old preset.
test_import_replaces_existing_preset_after_validation() {
    info "Test 17: Replacing an existing preset after validation"
    local fixture install_dir archive_src archive output
    fixture="$TEST_DIR/valid-overwrite"
    install_dir=$(make_install_fixture "valid-overwrite")
    archive_src="$fixture/archive"
    archive="$fixture/replace.tar.gz"
    output="$fixture/output.log"

    write_valid_preset "$install_dir/presets/replace" "operator data"
    printf 'old-only\n' > "$install_dir/presets/replace/old-only.txt"
    write_valid_preset "$archive_src/replace" "archive data"
    tar -czf "$archive" -C "$archive_src" replace

    if ! printf 'y\n' | ODS_HOME="$install_dir" bash "$install_dir/ods-cli" preset import "$archive" >"$output" 2>&1; then
        fail "Valid replacement archive was rejected"
        return 0
    fi
    if [[ "$(cat "$install_dir/presets/replace/marker.txt")" != "archive data" \
        || -e "$install_dir/presets/replace/old-only.txt" ]]; then
        fail "Validated replacement was merged with stale preset contents"
        return 0
    fi

    pass "Validated replacement atomically supersedes the old preset"
}

# Test 18: if the final publish move fails, the previous preset must be put
# back before the command exits non-zero.
test_import_rolls_back_failed_publish() {
    info "Test 18: Restoring the previous preset after publish failure"
    local fixture install_dir archive_src archive before output real_mv
    fixture="$TEST_DIR/publish-rollback"
    install_dir=$(make_install_fixture "publish-rollback")
    archive_src="$fixture/archive"
    archive="$fixture/replace.tar.gz"
    before="$fixture/replace-marker.before"
    output="$fixture/output.log"
    real_mv=$(command -v mv)

    write_valid_preset "$install_dir/presets/replace" "operator data"
    cp "$install_dir/presets/replace/marker.txt" "$before"
    write_valid_preset "$archive_src/replace" "archive data"
    tar -czf "$archive" -C "$archive_src" replace

    mkdir -p "$fixture/bin"
    cat > "$fixture/bin/mv" <<'MV_STUB'
#!/usr/bin/env bash
set -euo pipefail
src="${1:-}"
dst="${2:-}"
if [[ "$src" == */.preset-import.*/replace && "$dst" == */presets/replace ]]; then
    exit 73
fi
exec "$REAL_MV" "$@"
MV_STUB
    chmod +x "$fixture/bin/mv"

    if printf 'y\n' | PATH="$fixture/bin:$PATH" REAL_MV="$real_mv" \
        ODS_HOME="$install_dir" bash "$install_dir/ods-cli" preset import "$archive" >"$output" 2>&1; then
        fail "Import reported success after the publish move failed"
        return 0
    fi
    if ! cmp -s "$before" "$install_dir/presets/replace/marker.txt"; then
        fail "Publish failure did not restore the previous preset"
        return 0
    fi
    if compgen -G "$install_dir/presets/.preset-import.*" >/dev/null; then
        fail "Successful rollback leaked its staging directory"
        return 0
    fi

    pass "Publish failure restores the previous preset and cleans staging"
}

# Run all tests
echo ""
echo -e "${BLUE}━━━ Preset Import/Export Tests ━━━${NC}"
echo ""

test_syntax
test_export_in_help
test_import_in_help
test_export_case
test_import_case
test_export_uses_tar
test_import_security
test_export_validation
test_import_validation
test_export_relative_paths
test_import_overwrite
test_usage_updated
test_import_rejects_multiple_roots_without_mutation
test_import_preserves_existing_preset_on_validation_failure
test_import_accepts_relative_archive_path
test_import_rejects_links
test_import_replaces_existing_preset_after_validation
test_import_rolls_back_failed_publish

# Summary
echo ""
echo -e "${BLUE}━━━ Test Summary ━━━${NC}"
echo ""
echo -e "  ${GREEN}Passed:${NC} $PASSED"
if [[ $FAILED -gt 0 ]]; then
    echo -e "  ${RED}Failed:${NC} $FAILED"
fi
echo ""

if [[ $FAILED -eq 0 ]]; then
    echo -e "${GREEN}✓ All tests passed${NC}"
    exit 0
else
    echo -e "${RED}✗ Some tests failed${NC}"
    exit 1
fi
