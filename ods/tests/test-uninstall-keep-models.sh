#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$ROOT_DIR/ods-uninstall.sh"
TEST_ROOT="$(mktemp -d -t ods-uninstall-models-XXXXXX)"
trap 'rm -rf "$TEST_ROOT"' EXIT

make_fixture() {
    local name="$1"
    local fixture="$TEST_ROOT/$name"
    local install_dir="$fixture/install"
    local mock_bin="$fixture/bin"

    mkdir -p "$install_dir/data/models/nested" "$mock_bin" "$fixture/home"
    cp "$TARGET" "$install_dir/ods-uninstall.sh"
    touch "$install_dir/ods-cli"
    printf 'weights\n' > "$install_dir/data/models/model.gguf"
    printf 'metadata\n' > "$install_dir/data/models/.catalog"
    printf 'nested\n' > "$install_dir/data/models/nested/tokenizer.json"

    for command_name in docker systemctl pgrep timeout sudo; do
        printf '#!/usr/bin/env bash\nexit 0\n' > "$mock_bin/$command_name"
        chmod +x "$mock_bin/$command_name"
    done

    printf '%s\n' "$fixture"
}

test_preserves_complete_tree_without_merging() {
    local fixture install_dir backup_dir output
    fixture="$(make_fixture preserve)"
    install_dir="$fixture/install"
    mkdir -p "$fixture/home/.ods-models-backup"
    printf 'older\n' > "$fixture/home/.ods-models-backup/existing.gguf"

    output="$(HOME="$fixture/home" PATH="$fixture/bin:$PATH" \
        bash "$install_dir/ods-uninstall.sh" --keep-models --force)"

    backup_dir="$(find "$fixture/home" -mindepth 1 -maxdepth 1 \
        -type d -name '.ods-models-backup-*' -print -quit)"
    [[ -n "$backup_dir" ]]
    [[ -f "$backup_dir/model.gguf" ]]
    [[ -f "$backup_dir/.catalog" ]]
    [[ -f "$backup_dir/nested/tokenizer.json" ]]
    [[ -f "$fixture/home/.ods-models-backup/existing.gguf" ]]
    [[ ! -e "$install_dir" ]]
    [[ "$output" == *"Your models were saved to: $backup_dir"* ]]
}

test_move_failure_keeps_install_tree() {
    local fixture install_dir
    fixture="$(make_fixture failure)"
    install_dir="$fixture/install"
    printf '#!/usr/bin/env bash\nexit 73\n' > "$fixture/bin/mv"
    chmod +x "$fixture/bin/mv"

    if HOME="$fixture/home" PATH="$fixture/bin:$PATH" \
        bash "$install_dir/ods-uninstall.sh" --keep-models --force \
        > "$fixture/output" 2>&1; then
        echo "expected model preservation failure" >&2
        return 1
    fi

    [[ -f "$install_dir/data/models/model.gguf" ]]
    [[ -f "$install_dir/data/models/.catalog" ]]
}

test_preserves_complete_tree_without_merging
test_move_failure_keeps_install_tree
echo "uninstall keep-models tests passed"
