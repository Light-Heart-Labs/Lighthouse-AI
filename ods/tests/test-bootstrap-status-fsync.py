#!/usr/bin/env python3
"""Regression tests for #2728 — write_status must write bootstrap-status.json
atomically with fsync so the file is never left truncated or corrupted on crash.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "bootstrap-upgrade.sh"


def _have_bash() -> bool:
    import shutil
    return shutil.which("bash") is not None


def _have_python() -> bool:
    import shutil
    return shutil.which("python3") is not None or shutil.which("python") is not None


# ---------------------------------------------------------------------------
# Source-level contract tests (no bash required)
# ---------------------------------------------------------------------------

def test_no_heredoc_mv_in_write_status() -> None:
    """Regression #2728: the old un-fsynced pattern must be absent from write_status."""
    source = SCRIPT.read_text(encoding="utf-8")

    # Locate write_status function body
    start = source.find("\nwrite_status() {")
    assert start != -1, "write_status function not found in bootstrap-upgrade.sh"

    # Extract roughly 150 lines worth of the function body
    body = source[start : start + 4000]

    assert "cat > " not in body or "cat >" not in body.split("PY")[0], (
        "write_status must not use 'cat >' shell redirection — use Python os.fsync + os.replace (#2728)"
    )
    assert "mv \"$STATUS_FILE.tmp\"" not in body, (
        "write_status must not use plain 'mv' for atomic replace — use Python os.replace (#2728)"
    )


def test_write_status_uses_python_fsync_pattern() -> None:
    """Regression #2728: write_status must delegate to Python with os.fsync and os.replace."""
    source = SCRIPT.read_text(encoding="utf-8")

    # The Python heredoc must be present inside the function
    assert "os.fsync" in source, (
        "write_status must call os.fsync() on the temp file before atomic replace (#2728)"
    )
    assert "os.replace" in source, (
        "write_status must use os.replace() for atomic rename (#2728)"
    )
    assert "tempfile.mkstemp" in source, (
        "write_status must use tempfile.mkstemp() so the temp file is in the same directory (#2728)"
    )


def test_python_cmd_resolved_before_write_status() -> None:
    """Regression #2728: PYTHON_CMD must be set before write_status is defined."""
    source = SCRIPT.read_text(encoding="utf-8")

    python_cmd_pos = source.find("PYTHON_CMD=")
    write_status_pos = source.find("\nwrite_status() {")

    assert python_cmd_pos != -1, "PYTHON_CMD must be defined in bootstrap-upgrade.sh (#2728)"
    assert write_status_pos != -1, "write_status function must exist in bootstrap-upgrade.sh"
    assert python_cmd_pos < write_status_pos, (
        "PYTHON_CMD must be resolved before write_status is defined (#2728)"
    )


def test_write_status_has_no_python_cmd_guard_removed() -> None:
    """Regression #2728: write_status must have a PYTHON_CMD guard for graceful degradation."""
    source = SCRIPT.read_text(encoding="utf-8")
    start = source.find("\nwrite_status() {")
    body = source[start: start + 4000]
    assert "PYTHON_CMD" in body, (
        "write_status must guard on PYTHON_CMD so it degrades gracefully when Python is absent (#2728)"
    )


# ---------------------------------------------------------------------------
# Functional tests (requires bash + python3)
# ---------------------------------------------------------------------------

@pytest.mark.skipif(
    not _have_bash() or sys.platform == "win32",
    reason="Functional test requires bash on a POSIX system",
)
def test_write_status_produces_valid_json() -> None:
    """Regression #2728: write_status must produce valid, complete JSON."""
    with tempfile.TemporaryDirectory(prefix="ods-bootstrap-test-") as tmp:
        status_file = Path(tmp) / "data" / "bootstrap-status.json"

        # Minimal environment to exercise write_status directly
        script = f"""
set -euo pipefail
INSTALL_DIR="{tmp}"
FULL_GGUF_FILE="test-model.gguf"
STATUS_FILE="{status_file}"
PYTHON_CMD="$(command -v python3 || command -v python)"

source "{SCRIPT}"

mkdir -p "{status_file.parent}"
write_status "downloading" "42.5" "1073741824" "2147483648" "52428800" "20s"
"""
        result = subprocess.run(
            ["bash", "-c", script],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, f"write_status failed:\n{result.stderr}"
        assert status_file.exists(), "bootstrap-status.json was not created"

        data = json.loads(status_file.read_text(encoding="utf-8"))
        assert data["status"] == "downloading"
        assert data["model"] == "test-model.gguf"
        assert abs(data["percent"] - 42.5) < 0.01
        assert data["bytesDownloaded"] == 1073741824
        assert data["bytesTotal"] == 2147483648
        assert data["speedBytesPerSec"] == 52428800
        assert data["eta"] == "20s"
        assert "updatedAt" in data


@pytest.mark.skipif(
    not _have_bash() or sys.platform == "win32",
    reason="Functional test requires bash on a POSIX system",
)
def test_write_status_null_percent_produces_valid_json() -> None:
    """Regression #2728: write_status with empty percent must produce JSON null (not empty string)."""
    with tempfile.TemporaryDirectory(prefix="ods-bootstrap-null-test-") as tmp:
        status_file = Path(tmp) / "data" / "bootstrap-status.json"

        script = f"""
set -euo pipefail
INSTALL_DIR="{tmp}"
FULL_GGUF_FILE="model.gguf"
STATUS_FILE="{status_file}"
PYTHON_CMD="$(command -v python3 || command -v python)"

source "{SCRIPT}"

mkdir -p "{status_file.parent}"
write_status "downloading" "" "0" "0" "0" ""
"""
        result = subprocess.run(
            ["bash", "-c", script],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, f"write_status failed:\n{result.stderr}"
        data = json.loads(status_file.read_text(encoding="utf-8"))
        assert data["percent"] is None, (
            "percent must be JSON null when not provided, not an empty string"
        )


@pytest.mark.skipif(
    not _have_bash() or sys.platform == "win32",
    reason="Functional test requires bash on a POSIX system",
)
def test_write_status_no_temp_file_left_on_success() -> None:
    """Regression #2728: no .bootstrap-status.*.tmp files must remain after a successful write."""
    with tempfile.TemporaryDirectory(prefix="ods-bootstrap-cleanup-test-") as tmp:
        status_file = Path(tmp) / "data" / "bootstrap-status.json"
        data_dir = status_file.parent

        script = f"""
set -euo pipefail
INSTALL_DIR="{tmp}"
FULL_GGUF_FILE="model.gguf"
STATUS_FILE="{status_file}"
PYTHON_CMD="$(command -v python3 || command -v python)"

source "{SCRIPT}"

mkdir -p "{data_dir}"
write_status "complete" "100" "4294967296" "4294967296" "0" ""
"""
        result = subprocess.run(
            ["bash", "-c", script],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, f"write_status failed:\n{result.stderr}"

        leftover = list(data_dir.glob(".bootstrap-status.*.tmp"))
        assert leftover == [], (
            f"Temporary file(s) leaked after successful write: {leftover}"
        )
