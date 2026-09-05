#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

preflight="$ROOT_DIR/installers/windows/phases/01-preflight.ps1"
requirements="$ROOT_DIR/installers/windows/phases/04-requirements.ps1"
detection="$ROOT_DIR/installers/windows/lib/detection.ps1"

grep -q 'function Get-WindowsDockerDataPath' "$detection"
grep -q 'function Test-WindowsDockerImageDiskSpace' "$detection"
grep -q 'Test-WindowsDockerImageDiskSpace' "$preflight"
grep -q 'Test-WindowsDockerImageDiskSpace' "$requirements"
grep -q 'Docker images still use Docker Desktop' "$preflight"
if grep -q 'InstallDir \${_sourceDrive}:\\ods' "$preflight"; then
    echo "[FAIL] phase 01 still suggests -InstallDir on the source drive"
    exit 1
fi

if command -v powershell.exe >/dev/null 2>&1; then
    PS_BIN="powershell.exe"
elif command -v pwsh >/dev/null 2>&1; then
    PS_BIN="pwsh"
else
    echo "[SKIP] PowerShell unavailable (bash wiring checks passed)"
    exit 0
fi

if command -v cygpath >/dev/null 2>&1; then
    TEST_PATH="$(cygpath -w "$ROOT_DIR/tests/test-windows-docker-disk-preflight.ps1")"
elif [[ "$PS_BIN" == "powershell.exe" ]] && command -v wslpath >/dev/null 2>&1; then
    TEST_PATH="$(wslpath -w "$ROOT_DIR/tests/test-windows-docker-disk-preflight.ps1")"
else
    TEST_PATH="$ROOT_DIR/tests/test-windows-docker-disk-preflight.ps1"
fi

"$PS_BIN" -NoProfile -ExecutionPolicy Bypass -File "$TEST_PATH"
