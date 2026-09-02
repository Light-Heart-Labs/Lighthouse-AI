#!/usr/bin/env python3
"""Return small, secret-free host capability observations for Pixel Operations."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
from typing import Sequence

MAX_OUTPUT = 64 * 1024
SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._+()/@-]{0,95}$")
SAFE_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$")


def _run(argv: Sequence[str], timeout: int = 8) -> subprocess.CompletedProcess[str] | None:
    try:
        result = subprocess.run(
            list(argv),
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
            env={"LANG": "C", "LC_ALL": "C", "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"},
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if len(result.stdout.encode("utf-8", "replace")) > MAX_OUTPUT:
        return None
    return result


def _trusted_executable(candidates: Sequence[str]) -> str | None:
    for raw in candidates:
        try:
            candidate = Path(raw).resolve(strict=True)
            info = candidate.stat()
        except OSError:
            continue
        if (
            not candidate.is_absolute()
            or not stat.S_ISREG(info.st_mode)
            or info.st_uid != 0
            or info.st_mode & 0o022
            or not os.access(candidate, os.X_OK)
        ):
            continue
        return str(candidate)
    return None


def observe_gpu() -> dict:
    executable = _trusted_executable([
        "/usr/lib/wsl/lib/nvidia-smi",
        "/usr/bin/nvidia-smi",
        "/usr/local/bin/nvidia-smi",
    ])
    devices: list[dict] = []
    if executable:
        result = _run(
            [
                executable,
                "--query-gpu=name,memory.total,driver_version",
                "--format=csv,noheader,nounits",
            ]
        )
        if result and result.returncode == 0 and not result.stderr.strip():
            for line in result.stdout.splitlines()[:16]:
                fields = [field.strip() for field in line.split(",")]
                if len(fields) != 3 or not SAFE_NAME.fullmatch(fields[0]) or not SAFE_VERSION.fullmatch(fields[2]):
                    devices = []
                    break
                try:
                    memory_mib = int(fields[1])
                except ValueError:
                    devices = []
                    break
                if not 1 <= memory_mib <= 10_000_000:
                    devices = []
                    break
                devices.append(
                    {"name": fields[0], "memoryMiB": memory_mib, "driver": fields[2]}
                )
    return {
        "schemaVersion": 1,
        "kind": "ods-host-gpu",
        "available": bool(devices),
        "backend": "nvidia" if devices else "unavailable",
        "devices": devices,
    }


def _native_tailscale_state() -> tuple[bool, str, bool] | None:
    executable = _trusted_executable(["/usr/bin/tailscale", "/usr/local/bin/tailscale"])
    if not executable:
        return None
    result = _run([executable, "status", "--json"])
    if not result or result.returncode != 0 or result.stderr.strip():
        return True, "unknown", False
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError:
        return True, "unknown", False
    raw = str(value.get("BackendState", "")).strip().casefold()
    states = {
        "running": "running",
        "starting": "starting",
        "stopped": "stopped",
        "needslogin": "needs-login",
        "needs-login": "needs-login",
    }
    state = states.get(raw, "unknown")
    return True, state, state == "running"


def _windows_tailscale_state() -> tuple[bool, str, bool] | None:
    powershell = Path("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe")
    if not powershell.is_file():
        return None
    result = _run(
        [
            str(powershell),
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$s=Get-Service -Name Tailscale -ErrorAction SilentlyContinue; if($null -eq $s){'missing'}else{$s.Status.ToString()}",
        ]
    )
    if not result or result.returncode != 0:
        return None
    raw = result.stdout.strip().casefold()
    if raw == "missing":
        return False, "not-installed", False
    if raw == "running":
        return True, "service-running", True
    if raw in {"stopped", "startpending", "stoppending", "paused", "pausepending", "continuepending"}:
        return True, "service-not-running", False
    return True, "unknown", False


def observe_tailscale() -> dict:
    result = _native_tailscale_state() or _windows_tailscale_state()
    available, state, service_running = result or (False, "not-installed", False)
    return {
        "schemaVersion": 1,
        "kind": "ods-host-tailscale",
        "available": available,
        "state": state,
        "serviceRunning": service_running,
    }


def main(argv: Sequence[str]) -> int:
    if len(argv) != 2 or argv[1] not in {"gpu", "tailscale"}:
        return 2
    value = observe_gpu() if argv[1] == "gpu" else observe_tailscale()
    print(json.dumps(value, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
