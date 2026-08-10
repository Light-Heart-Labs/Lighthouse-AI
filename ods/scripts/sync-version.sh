#!/usr/bin/env bash
#=============================================================================
# Sync every literal ODS version copy from the canonical ods/VERSION file.
#
# ods/VERSION is the single edit point. Every other location that must carry
# the version as a language-native literal (bash, PowerShell, JSON, Python,
# Markdown) is regenerated from it here. Run `scripts/check-version-consistency.py`
# afterward (or `make gate`) to confirm nothing drifted.
#
# Usage: scripts/sync-version.sh [new-version]
#   With an argument, writes it to ods/VERSION first, then syncs.
#   Without one, syncs every target file from the current ods/VERSION content.
#=============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

_sed_i() {
    if sed --version 2>/dev/null | grep -q GNU; then
        sed -i "$@"
    else
        sed -i '' "$@"
    fi
}

if [[ $# -ge 1 ]]; then
    printf '%s\n' "$1" > VERSION
fi

VERSION="$(tr -d '[:space:]' < VERSION)"
if [[ -z "$VERSION" ]]; then
    echo "[error] VERSION file is empty" >&2
    exit 1
fi

echo "[sync-version] Propagating VERSION=$VERSION"

command -v jq >/dev/null 2>&1 || { echo "[error] jq is required" >&2; exit 1; }
jq --arg v "$VERSION" '.ods_version = $v | .release.version = $v' manifest.json > manifest.json.tmp
mv manifest.json.tmp manifest.json

_sed_i "s/^VERSION=\"[^\"]*\"/VERSION=\"${VERSION}\"/" installers/lib/constants.sh
_sed_i "s/^ODS_VERSION=\"[^\"]*\"/ODS_VERSION=\"${VERSION}\"/" installers/macos/lib/constants.sh
_sed_i "s/^\(\$script:ODS_VERSION = \"\)[^\"]*\(\"\)/\1${VERSION}\2/" installers/windows/lib/constants.ps1
_sed_i "s/^ODS_VERSION=\${VERSION:-[^}]*}/ODS_VERSION=\${VERSION:-${VERSION}}/" installers/phases/06-directories.sh
_sed_i "s/version=\"[^\"]*\",/version=\"${VERSION}\",/" extensions/services/dashboard-api/main.py
_sed_i "s/^VERSION=\"[^\"]*\"/VERSION=\"${VERSION}\"/" ods-cli
_sed_i "s/^> Version [^ ]* |/> Version ${VERSION} |/" ../ARCHITECTURE.md

echo "[sync-version] Done. Verify with: python3 scripts/check-version-consistency.py"
