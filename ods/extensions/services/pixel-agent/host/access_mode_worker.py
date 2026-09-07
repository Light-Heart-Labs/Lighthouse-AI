#!/usr/bin/env python3
"""Owner-only controller process; root retains restart and gate authority.

Only fixed JSON hook names cross the pipe. No config, CLI diagnostics, token,
command or arbitrary path is returned to the caller.
"""
import json
import os
import subprocess
import sys
from pathlib import Path
import stat

# The privileged installer places only these reviewed modules together. Isolated
# Python excludes cwd, PYTHONPATH and user site packages; add this protected path.
directory = Path(__file__).resolve().parent
for path in (directory, *directory.parents, directory / "pixel_access_mode.py", directory / "access_mode_config.py"):
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise RuntimeError("controller program custody unavailable")
sys.path.insert(0, str(directory))
import pixel_access_mode as controller


def emit(value):
    print(json.dumps(value, separators=(",", ":")), flush=True)


def main():
    request = json.loads(sys.stdin.readline(4096))
    path = os.path.join(os.environ["HOME"], ".openclaw", "openclaw.json")

    def hook(name):
        emit({"hook": name})
        response = json.loads(sys.stdin.readline(128))
        if type(response) is not bool:
            raise RuntimeError("invalid host hook response")
        return response

    def validate(staged):
        env = dict(os.environ, OPENCLAW_CONFIG_PATH=staged)
        try:
            result = subprocess.run([request["openclaw"], "config", "validate"],
                                    env=env, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL, timeout=120)
            return result.returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            return False

    try:
        if request["operation"] != "status":
            kwargs = dict(validate_config=validate, restart=lambda: hook("restart"),
                          check_no_active_run=lambda: hook("busy"),
                          expected_config_sha256=request["config_sha256"])
            if request["operation"] == "full-access":
                controller.enable_full_access(path, confirmed=request["confirmed"], **kwargs)
            elif request["operation"] == "sandboxed":
                controller.restore_sandbox(path, **kwargs)
            else:
                raise RuntimeError("unsupported operation")
        emit({"result": controller.get_status(path)})
    except controller.AccessModeError as error:
        emit({"error": error.code})
    except Exception:
        emit({"error": "owner-operation-failed"})


if __name__ == "__main__":
    main()
