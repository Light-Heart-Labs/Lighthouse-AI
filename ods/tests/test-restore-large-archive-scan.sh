#!/usr/bin/env bash
# Boundary coverage for complete archive scans under strict pipefail.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURE="$(mktemp -d "${TMPDIR:-/tmp}/ods-restore-archive.XXXXXX")"
trap 'rm -rf "$FIXTURE"' EXIT

ODS_FIXTURE="$FIXTURE/ods"
mkdir -p "$ODS_FIXTURE/.backups" "$ODS_FIXTURE/data" "$ODS_FIXTURE/lib"
cp "$ROOT_DIR/lib/rsync.sh" "$ODS_FIXTURE/lib/rsync.sh"

python3 - "$ODS_FIXTURE/.backups" <<'PY'
import io
import json
import sys
import tarfile
from pathlib import Path

root = Path(sys.argv[1])

manifest = json.dumps({
    "manifest_version": "1.0",
    "backup_id": "20260902-120000",
    "backup_type": "user-data",
    "description": "large archive",
    "contents": {"user_data": True, "config": False, "cache": False},
}).encode()

with tarfile.open(root / "20260902-120000.tar.gz", "w:gz") as bundle:
    info = tarfile.TarInfo("20260902-120000/manifest.json")
    info.size = len(manifest)
    bundle.addfile(info, io.BytesIO(manifest))
    for index in range(30000):
        bundle.addfile(tarfile.TarInfo(f"20260902-120000/data/entry-{index:05d}"))

with tarfile.open(root / "20260902-130000.tar.gz", "w:gz") as bundle:
    bundle.addfile(tarfile.TarInfo("../escape"))
    for index in range(30000):
        bundle.addfile(tarfile.TarInfo(f"20260902-130000/data/entry-{index:05d}"))
PY

list_output=$(ODS_DIR="$ODS_FIXTURE" bash "$ROOT_DIR/ods-restore.sh" --list)
grep -E '20260902-120000[[:space:]]+user-data' <<< "$list_output" >/dev/null || {
    echo "large compressed backup lost its manifest metadata" >&2
    exit 1
}

set +e
restore_output=$(ODS_DIR="$ODS_FIXTURE" bash "$ROOT_DIR/ods-restore.sh" --force 20260902-130000 2>&1)
restore_status=$?
set -e
[[ "$restore_status" -ne 0 ]] || {
    echo "unsafe archive was accepted" >&2
    exit 1
}
grep -F 'contains unsafe paths' <<< "$restore_output" >/dev/null || {
    echo "unsafe member was not rejected by the pre-extraction scan" >&2
    exit 1
}
[[ ! -e "$FIXTURE/escape" ]] || {
    echo "unsafe archive wrote outside the backup root" >&2
    exit 1
}

echo "Large restore archives retain metadata and safety matches"
