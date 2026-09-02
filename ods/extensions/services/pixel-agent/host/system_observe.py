#!/usr/bin/env python3
"""Return small, secret-free host capability observations for Pixel Operations."""

from __future__ import annotations

import base64
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
INTEROP_NAME = re.compile(r"^[1-9][0-9]{0,19}_interop$")
INTEROP_ROOT = Path("/run/WSL")
WINDOWS_POWERSHELL = Path("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe")


def _run(
    argv: Sequence[str],
    timeout: int = 8,
    extra_env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str] | None:
    environment = {
        "LANG": "C",
        "LC_ALL": "C",
        "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    }
    if extra_env:
        environment.update(extra_env)
    try:
        result = subprocess.run(
            list(argv),
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=environment,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if (
        len(result.stdout.encode("utf-8", "replace")) > MAX_OUTPUT
        or len(result.stderr.encode("utf-8", "replace")) > MAX_OUTPUT
    ):
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


def _trusted_interop_sockets(root: Path = INTEROP_ROOT) -> list[Path]:
    try:
        root_info = root.lstat()
        if (
            not stat.S_ISDIR(root_info.st_mode)
            or stat.S_ISLNK(root_info.st_mode)
            or root_info.st_uid != 0
            or root_info.st_mode & 0o022
        ):
            return []
        candidates: list[tuple[int, Path]] = []
        for candidate in root.iterdir():
            if not INTEROP_NAME.fullmatch(candidate.name):
                continue
            info = candidate.lstat()
            if stat.S_ISSOCK(info.st_mode) and not stat.S_ISLNK(info.st_mode) and info.st_uid == 0:
                candidates.append((info.st_mtime_ns, candidate))
    except OSError:
        return []
    candidates.sort(key=lambda item: item[0], reverse=True)
    return [candidate for _, candidate in candidates[:8]]


def _windows_powershell_result(command: str) -> subprocess.CompletedProcess[str] | None:
    try:
        executable = WINDOWS_POWERSHELL.resolve(strict=True)
        info = executable.stat()
    except OSError:
        return None
    if (
        executable != WINDOWS_POWERSHELL
        or not stat.S_ISREG(info.st_mode)
        or info.st_mode & 0o022
        or not os.access(executable, os.X_OK)
    ):
        return None
    encoded = base64.b64encode(command.encode("utf-16le")).decode("ascii")
    argv = [
        str(executable),
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encoded,
    ]
    for socket_path in _trusted_interop_sockets():
        result = _run(argv, timeout=3, extra_env={"WSL_INTEROP": str(socket_path)})
        if result and result.returncode == 0 and result.stdout.strip():
            return result
    return None


def _windows_tailscale_state() -> tuple[bool, str, bool] | None:
    result = _windows_powershell_result(
        "$s=Get-Service -Name Tailscale -ErrorAction SilentlyContinue; "
        "if($null -eq $s){'missing'}else{$s.Status.ToString()}"
    )
    if not result:
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
