#!/usr/bin/env bash
# Contract: every platform update command gates its success receipt on the
# exact active Compose plan. Linux is the established implementation.

set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
linux_cli="$root_dir/ods-cli"
macos_cli="$root_dir/installers/macos/ods-macos.sh"
windows_cli="$root_dir/installers/windows/ods.ps1"

linux_update="$(awk '/^cmd_update\(\)/,/^}/' "$linux_cli")"
macos_update="$(awk '/^cmd_update\(\)/,/^}/' "$macos_cli")"
windows_update="$(awk '/^function Invoke-Update/,/^}/' "$windows_cli")"

grep -q 'config --services' <<< "$linux_update" || {
    printf '[FAIL] Linux update no longer reads the active Compose plan\n' >&2
    exit 1
}
grep -q 'macos_verify_compose_update' <<< "$macos_update" || {
    printf '[FAIL] macOS update does not gate success on Compose verification\n' >&2
    exit 1
}
grep -q 'config --services' <<< "$windows_update" || {
    printf '[FAIL] Windows update does not read the active Compose plan\n' >&2
    exit 1
}
grep -q 'Test-ODSComposeServicesStarted' <<< "$windows_update" || {
    printf '[FAIL] Windows update does not verify active service container states\n' >&2
    exit 1
}

windows_verify_line="$(grep -n 'Test-ODSComposeServicesStarted' <<< "$windows_update" | head -1 | cut -d: -f1)"
windows_success_line="$(grep -n 'Write-AISuccess "Update complete"' <<< "$windows_update" | head -1 | cut -d: -f1)"
[[ -n "$windows_verify_line" && -n "$windows_success_line" && "$windows_verify_line" -lt "$windows_success_line" ]] || {
    printf '[FAIL] Windows emits Update complete before service verification\n' >&2
    exit 1
}

printf '[PASS] update success is verification-gated on every platform\n'
