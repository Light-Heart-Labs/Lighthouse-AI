"""Authenticated host-agent adapter for the managed POSIX/systemd Pixel.

Root controls the two admission leases and one narrowly scoped systemd drop-in.
The existing config controller and installed validator run as the service owner.
No request can choose a path, command, UID, endpoint or service name.
"""
from __future__ import annotations

import contextlib
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import platform
import re
import selectors
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request

UNIT = "openclaw-gateway.service"
STATE = Path("/var/lib/ods-pixel-access")
DROPIN = Path("/etc/systemd/system/openclaw-gateway.service.d/90-ods-full-access.conf")
HEX = re.compile(r"^[a-f0-9]{64}$")


class AccessError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def private_json(path, uid, maximum=1024 * 1024):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != uid or info.st_nlink != 1
                or info.st_mode & 0o077 or info.st_size > maximum):
            raise AccessError("unsafe-owner-state")
        with os.fdopen(fd, "rb", closefd=False) as handle:
            return json.load(handle)
    finally:
        os.close(fd)


def atomic_json(path, value):
    fd, temporary = tempfile.mkstemp(prefix=".transition-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(value, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        parent = os.open(path.parent, os.O_RDONLY)
        try: os.fsync(parent)
        finally: os.close(parent)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)


class SystemdAccessBridge:
    def __init__(self, install_dir, edge_key, *, state=STATE, dropin=DROPIN, installed_binary=None, gateway_owner=None):
        self.install = Path(install_dir).resolve()
        self.edge_key = edge_key
        self.state = Path(state)
        self.dropin = Path(dropin)
        self.installed_binary, self.gateway_owner = installed_binary, gateway_owner

    def command(self, args, timeout=20):
        try:
            result = subprocess.run(args, check=True, stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, text=True, timeout=timeout)
            return result.stdout.strip()
        except (OSError, subprocess.SubprocessError):
            raise AccessError("host-command-failed") from None

    def discover(self):
        if platform.system() != "Linux":
            raise AccessError("macos-launchd-adapter-missing" if platform.system() == "Darwin" else "native-windows-adapter-missing")
        if os.geteuid() != 0: raise AccessError("root-host-adapter-required")
        if not Path("/run/systemd/system").is_dir(): raise AccessError("systemd-unavailable")
        program = Path(__file__).resolve()
        for path in (program, *program.parents):
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                raise AccessError("root-program-custody-required")
        # A root host agent must also execute protected code. Normal installs
        # run it as the owner; historical root overrides need an explicit repair.
        agent_user = self.command(["systemctl", "show", "ods-host-agent.service", "--property=User", "--value"])
        if agent_user in ("", "root", "0"):
            pid = int(self.command(["systemctl", "show", "ods-host-agent.service", "--property=MainPID", "--value"]))
            args = Path("/proc/%d/cmdline" % pid).read_bytes().split(b"\0")
            if b"-I" not in args: raise AccessError("root-host-agent-isolation-required")
            scripts = [Path(os.fsdecode(arg)) for arg in args if arg.endswith(b"ods-host-agent.py")]
            if len(scripts) != 1 or not scripts[0].is_absolute(): raise AccessError("root-host-agent-custody-required")
            for path in (scripts[0], *scripts[0].parents):
                info = path.lstat()
                if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                    raise AccessError("root-host-agent-custody-required")
            for directory, folders, files in os.walk(scripts[0].parent, followlinks=False):
                for name in folders + files:
                    info = (Path(directory) / name).lstat()
                    if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                        raise AccessError("root-host-agent-custody-required")
        import pwd
        user = self.command(["systemctl", "show", UNIT, "--property=User", "--value"])
        if not re.fullmatch(r"[a-z_][a-z0-9_-]*", user): raise AccessError("gateway-owner-unavailable")
        if user != self.gateway_owner: raise AccessError("installed-owner-changed")
        owner = pwd.getpwnam(user)
        home = Path(owner.pw_dir)
        if owner.pw_uid == 0 or not home.is_absolute() or home.resolve() != home:
            raise AccessError("unsafe-gateway-owner")
        marker = private_json(home / ".config/ods/pixel-managed.json", owner.pw_uid, 65536)
        if (marker.get("schema_version") != 2 or marker.get("manager") != "ods"
                or marker.get("state") != "ready" or Path(marker.get("install_dir", "")).resolve() != self.install):
            raise AccessError("managed-owner-mismatch")
        config = private_json(home / ".openclaw/openclaw.json", owner.pw_uid)
        binary = self.installed_binary
        if not isinstance(binary, str) or not Path(binary).is_absolute() or not os.access(binary, os.X_OK):
            raise AccessError("installed-validator-unavailable")
        port = config.get("gateway", {}).get("port", 18789)
        token = config.get("gateway", {}).get("auth", {}).get("token")
        if type(port) is not int or not 1 <= port <= 65535 or not isinstance(token, str) or not 16 <= len(token) <= 4096:
            raise AccessError("gateway-auth-unavailable")
        self.owner, self.home, self.binary = owner, home, binary
        self.native_origin, self.native_key = "http://127.0.0.1:%d" % port, token
        self.surface = "wsl-systemd" if "microsoft" in platform.release().lower() else "linux-systemd"

    def http(self, origin, path, key, payload=None, timeout=20):
        if any(ord(char) < 32 for char in key): raise AccessError("invalid-service-auth")
        body = json.dumps(payload).encode() if payload is not None else None
        request = urllib.request.Request(origin + path, data=body,
                                         headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
        try:
            # The origin is derived from the fixed service, never request input.
            with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=timeout) as response:
                raw = response.read(65537)
            if len(raw) > 65536: raise ValueError()
            value = json.loads(raw)
            if not isinstance(value, dict): raise ValueError()
            return value
        except Exception:
            raise AccessError("runtime-unavailable-or-busy") from None

    def native(self, operation=None, token=None):
        payload = None
        if operation:
            snapshot = self.native()
            if snapshot.get("stopped"):
                if operation != "acquire": raise AccessError("gateway-restart-required")
                return self.stopped_native(token)
            payload = dict(operation=operation, token=token, revision=snapshot["revision"])
        try:
            return self.http(self.native_origin, "/pixel-ods/access-runtime", self.native_key, payload, timeout=60)
        except AccessError:
            pending = self.pending()
            if operation is None and pending:
                return self.stopped_native(pending["token"])
            raise

    def stopped_native(self, token):
        """Crash recovery only: an owned durable hold and an empty stopped unit.

        An unreachable HTTP endpoint alone never proves idle. Never stop/kill an
        active unit to satisfy this check.
        """
        values = self.command(["systemctl", "show", UNIT, "--property=MainPID,ActiveState,ControlGroup"])
        fields = dict(line.split("=", 1) for line in values.splitlines() if "=" in line)
        if fields.get("MainPID") != "0" or fields.get("ActiveState") not in ("inactive", "failed"):
            raise AccessError("native-idle-unconfirmed")
        group = fields.get("ControlGroup", "")
        if group:
            root = Path("/sys/fs/cgroup")
            path = (root / group.lstrip("/")).resolve()
            if root not in path.parents: raise AccessError("native-idle-unconfirmed")
            if path.exists() and (path / "cgroup.procs").read_text().strip():
                raise AccessError("native-idle-unconfirmed")
        state = private_json(self.home / ".openclaw/.ods-access-runtime/state.json", self.owner.pw_uid, 4096)
        if (state.get("phase") != "held" or state.get("tokenHash") != hashlib.sha256(token.encode()).hexdigest()
                or not HEX.fullmatch(state.get("revision", ""))):
            raise AccessError("native-lease-unconfirmed")
        return {"available": True, "phase": "held", "revision": state["revision"], "active": 0,
                "pid": 0, "proof": None, "stopped": True}

    def edge(self, operation=None, token=None, revision=None):
        if not isinstance(self.edge_key, str) or len(self.edge_key) < 32: raise AccessError("edge-owner-auth-unavailable")
        networks = json.loads(self.command(["docker", "inspect", "ods-pixel-edge", "--format", "{{json .NetworkSettings.Networks}} "]))
        addresses = {value.get("IPAddress") for value in networks.values() if value.get("IPAddress")}
        if len(addresses) != 1: raise AccessError("edge-network-ambiguous")
        address = addresses.pop()
        ip = ipaddress.ip_address(address)
        if ip.version != 4 or not ip.is_private: raise AccessError("edge-network-invalid")
        payload = dict(token=token, revision=revision) if operation else None
        return self.http("http://%s:9595" % address, "/v1/transition" + ("/" + operation if operation else ""), self.edge_key, payload)

    def worker(self, operation="status", *, confirmed=False, config_hash=None, busy=None, restart=None):
        script = Path(__file__).resolve().parent / "access_mode_worker.py"
        # This launcher still runs as root. Never search the owner's validator
        # PATH for it; that PATH is intended only for the unprivileged worker.
        launcher = None
        for candidate in (Path("/usr/sbin/runuser"), Path("/sbin/runuser")):
            try:
                resolved = candidate.resolve(strict=True)
                for entry in (resolved, *resolved.parents):
                    info = entry.lstat()
                    if info.st_uid != 0 or info.st_mode & 0o022:
                        raise AccessError("unsafe-owner-launcher")
                if not resolved.is_file() or not os.access(resolved, os.X_OK):
                    continue
                launcher = str(resolved)
                break
            except FileNotFoundError:
                continue
        if launcher is None:
            raise AccessError("owner-launcher-unavailable")
        env = {"HOME": str(self.home), "USER": self.owner.pw_name, "LOGNAME": self.owner.pw_name,
               "PATH": str(Path(self.binary).parent) + ":/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"}
        request = dict(operation=operation, openclaw=self.binary, config_sha256=config_hash, confirmed=confirmed)
        process = subprocess.Popen([launcher, "-u", self.owner.pw_name, "--", sys.executable, "-I", "-u", str(script)],
                                   cwd="/", env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, text=True, bufsize=1)
        try:
            process.stdin.write(json.dumps(request) + "\n")
            process.stdin.flush()
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                deadline = time.monotonic() + 300
                while time.monotonic() < deadline:
                    if not selector.select(1): continue
                    line = process.stdout.readline(8193)
                    if not line or len(line) > 8192: raise AccessError("owner-protocol-failed")
                    value = json.loads(line)
                    if set(value) == {"result"}:
                        process.wait(timeout=5)
                        if process.returncode != 0: raise AccessError("owner-worker-failed")
                        return value["result"]
                    if set(value) == {"error"}: raise AccessError("controller-" + value["error"])
                    if set(value) != {"hook"}: raise AccessError("owner-protocol-failed")
                    callback = {"busy": busy, "restart": restart}.get(value["hook"])
                    if callback is None: raise AccessError("owner-protocol-failed")
                    answer = callback()
                    if type(answer) is not bool: raise AccessError("host-hook-failed")
                    process.stdin.write(json.dumps(answer) + "\n")
                    process.stdin.flush()
            raise AccessError("owner-worker-timeout")
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=10)

    def pending(self):
        file = self.state / "transition.json"
        return private_json(file, 0, 8192) if file.exists() else None

    @contextlib.contextmanager
    def locked(self):
        import fcntl
        self.state.mkdir(mode=0o700, parents=False, exist_ok=True)
        info = self.state.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077: raise AccessError("unsafe-host-state")
        fd = os.open(self.state / "lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o077:
                raise AccessError("unsafe-host-lock")
            try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: raise AccessError("transition-busy") from None
            yield
        finally: os.close(fd)

    def inspect(self):
        self.discover()
        config, native, edge = self.worker(), self.native(), self.edge()
        if not native.get("available") or edge.get("capability") != "available": raise AccessError("admission-gate-unavailable")
        pid = int(self.command(["systemctl", "show", UNIT, "--property=MainPID", "--value"]))
        if native.get("pid") != pid or (pid <= 0 and not native.get("stopped")): raise AccessError("gateway-process-mismatch")
        pending = self.pending()
        revision = digest([config.get("config_sha256"), native.get("revision"), edge.get("revision"), pid,
                           pending.get("phase") if pending else None])
        proof = native.get("proof")
        verified = private_json(self.state / "verified.json", 0, 8192) if (self.state / "verified.json").exists() else {}
        effective = proof.get("mode") if (isinstance(proof, dict) and proof.get("executed") is True and proof.get("pid") == pid
                    and verified.get("pid") == pid and verified.get("config_sha256") == config.get("config_sha256")
                    and verified.get("proof") == proof) else "unknown"
        if effective != config.get("configured_status") or pending or verified.get("boundary") != self.unit_boundary(): effective = "unknown"
        return {"available": True, "surface": self.surface, "configured_mode": config.get("configured_status", "unknown"),
                "effective_mode": effective, "runtime_verified": effective != "unknown", "revision": revision,
                "busy": bool(native.get("active") or edge.get("streams")), "pending": pending is not None,
                "reason": "transition-recovery-required" if pending else ("runtime-proof-required" if effective == "unknown" else None),
                "scope": "owner-host", "_config": config, "_native": native, "_edge": edge}

    def status(self):
        try: return {key: value for key, value in self.inspect().items() if not key.startswith("_")}
        except Exception as error:
            return {"available": False, "surface": platform.system().lower(), "configured_mode": "unknown",
                    "effective_mode": "unknown", "runtime_verified": False, "revision": None, "busy": False,
                    "pending": False, "reason": error.code if isinstance(error, AccessError) else "inspection-failed", "scope": "owner-host"}

    def dropin_for(self, enabled):
        # These two namespace restrictions create the filesystem sandbox.
        # Keep UID/DAC, NNP, capability limits, private /tmp, and explicit readonly
        # binary/plugin binds. Never reset a list or overwrite another drop-in.
        content = "[Service]\nProtectSystem=false\nProtectHome=false\n"
        self.dropin.parent.mkdir(mode=0o755, exist_ok=True)
        for path in (self.dropin.parent, *self.dropin.parent.parents):
            info = path.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                raise AccessError("unsafe-service-dropin-directory")
        if self.dropin.exists():
            info = self.dropin.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o022 or self.dropin.read_text() != content:
                raise AccessError("unrecognized-service-dropin")
        if enabled and not self.dropin.exists():
            fd = os.open(self.dropin, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o644)
            with os.fdopen(fd, "w") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
        elif not enabled and self.dropin.exists(): self.dropin.unlink()
        self.command(["systemctl", "daemon-reload"])

    def unit_boundary(self):
        return self.command(["systemctl", "show", UNIT, "--property=ProtectSystem,ProtectHome,NoNewPrivileges,CapabilityBoundingSet,BindReadOnlyPaths,ReadOnlyPaths,PrivateTmp"])

    def provision_probe(self):
        base = Path("/var/lib/ods-pixel-access-probes")
        base.mkdir(mode=0o711, exist_ok=True)
        info = base.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise AccessError("unsafe-probe-directory")
        # The coordinator's 0077 umask otherwise makes this root-only and
        # prevents the gateway owner reaching its private child directory.
        os.chmod(base, 0o711)
        target = base / str(self.owner.pw_uid)
        try:
            target.mkdir(mode=0o700)
            os.chown(target, self.owner.pw_uid, self.owner.pw_gid)
        except FileExistsError: pass
        info = target.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != self.owner.pw_uid or info.st_mode & 0o077:
            raise AccessError("unsafe-probe-directory")

    def change(self, request):
        if (not isinstance(request, dict) or set(request) != {"mode", "revision", "confirmed"}
                or request["mode"] not in ("full-access", "sandboxed") or type(request["confirmed"]) is not bool
                or not isinstance(request["revision"], str) or not HEX.fullmatch(request["revision"])):
            raise AccessError("invalid-request")
        if request["mode"] == "full-access" and not request["confirmed"]: raise AccessError("confirmation-required")
        with self.locked():
            snapshot = self.inspect()
            if snapshot["revision"] != request["revision"]: raise AccessError("inspection-changed")
            if snapshot["busy"]: raise AccessError("runtime-busy")
            pending = self.pending()
            if pending and request["mode"] != "sandboxed": raise AccessError("restore-required")
            if not pending:
                pending = {"token": os.urandom(32).hex(), "phase": "acquiring", "edge_revision": snapshot["_edge"]["revision"]}
                atomic_json(self.state / "transition.json", pending)
            token = pending["token"]
            try:
                if snapshot["_edge"]["phase"] == "idle": pending["edge_revision"] = snapshot["_edge"]["revision"]
                edge = self.edge("recover" if snapshot["_edge"]["phase"] == "interrupted" else "acquire", token, pending["edge_revision"])
                pending["edge_revision"] = edge["revision"]
                atomic_json(self.state / "transition.json", pending)
                self.native("acquire", token)

                def busy():
                    native = self.native("acquire", token)
                    edge = self.edge("acquire", token, pending["edge_revision"])
                    return native.get("phase") != "held" or edge.get("phase") != "held" or bool(native.get("active") or edge.get("streams"))

                def restart():
                    if busy(): return False
                    current = private_json(self.home / ".openclaw/openclaw.json", self.owner.pw_uid)
                    agents = [agent for agent in current.get("agents", {}).get("list", []) if agent.get("id") == "pixel"]
                    if len(agents) != 1: return False
                    self.dropin_for(agents[0].get("sandbox", {}).get("mode") == "off" and agents[0].get("tools", {}).get("exec", {}).get("host") == "gateway")
                    old_pid = self.native()["pid"]
                    self.command(["systemctl", "restart", UNIT], timeout=60)
                    for _ in range(30):
                        try:
                            status = self.native()
                            if status.get("available") and status.get("pid") != old_pid and status.get("phase") == "held":
                                # The same durable token must still own the restarted gateway.
                                self.native("acquire", token)
                                health = self.http(self.native_origin, "/health", self.native_key)
                                return health.get("ok") is True
                        except AccessError: pass
                        time.sleep(1)
                    return False

                if busy(): raise AccessError("runtime-busy")
                self.provision_probe()
                baseline_file = self.state / "service-baseline.json"
                if not baseline_file.exists():
                    if self.dropin.exists(): raise AccessError("service-baseline-missing")
                    atomic_json(baseline_file, {"boundary": self.unit_boundary()})
                pending["phase"] = "applying"
                atomic_json(self.state / "transition.json", pending)
                config = snapshot["_config"]
                # A pristine safe configuration can be verified without inventing
                # a baseline or performing an unnecessary restore.
                if not (request["mode"] == "sandboxed" and not config.get("managed") and config.get("configured_status") == "sandboxed"):
                    self.worker(request["mode"], confirmed=request["confirmed"], config_hash=config["config_sha256"], busy=busy, restart=restart)
                elif self.dropin.exists():
                    if not restart(): raise AccessError("restore-restart-failed")
                # A pending journal alone does not mean this pristine config
                # changed. Recheck the actual service boundary and core tools
                # below; restarting again can perpetually interrupt recovery.
                boundary = self.unit_boundary()
                baseline = private_json(baseline_file, 0, 8192)["boundary"]
                if request["mode"] == "sandboxed":
                    if boundary != baseline: raise AccessError("service-restore-mismatch")
                else:
                    def other_settings(value):
                        return [line for line in value.splitlines() if not line.startswith(("ProtectSystem=", "ProtectHome="))]
                    if ("ProtectSystem=no" not in boundary or "ProtectHome=no" not in boundary
                            or other_settings(boundary) != other_settings(baseline)):
                        raise AccessError("service-boundary-mismatch")
                proof = self.native("probe", token)
                if proof.get("proof", {}).get("mode") != request["mode"]: raise AccessError("runtime-proof-failed")
                verified_config = self.worker()
                atomic_json(self.state / "verified.json", {"pid": proof["pid"], "proof": proof["proof"],
                            "config_sha256": verified_config["config_sha256"], "boundary": boundary})
                pending["phase"] = "releasing"
                atomic_json(self.state / "transition.json", pending)
                self.edge("release", token, pending["edge_revision"])
                self.native("release", token)
                (self.state / "transition.json").unlink()
                return self.status()
            except Exception as error:
                pending["phase"] = "error"
                atomic_json(self.state / "transition.json", pending)
                if isinstance(error, AccessError): raise
                raise AccessError("transition-failed") from None
