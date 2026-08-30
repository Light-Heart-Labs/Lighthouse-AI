#!/usr/bin/env python3
"""Narrow ODS extension lifecycle proxy for Pixel Operations.

The server owns the ODS dashboard credential and exposes only a fixed local
grammar over a Unix socket.  The Pixel Operations Broker never receives the
credential, Docker access, an arbitrary HTTP client, or a generic host shell.
"""

from __future__ import annotations

import http.client
import json
import os
import pathlib
import pwd
import re
import socket
import stat
import struct
import sys
import time
import urllib.parse
from typing import Any


SCHEMA_VERSION = 1
KIND = "ods-pixel-extension-lifecycle"
BOUNDARY = (
    "Scoped ODS extension lifecycle proxy; it grants no Docker, shell, "
    "credential, arbitrary HTTP, or data-purge authority."
)
SERVICE_ID = re.compile(r"^[a-z0-9](?:[a-z0-9_-]|\.(?=[a-z0-9])){0,63}$")
HEX_KEY = re.compile(r"^[0-9a-f]{64}$")
ALLOWED_ACTIONS = frozenset({"inspect", "install", "enable", "disable", "remove"})
MAX_REQUEST_BYTES = 4096
MAX_RESPONSE_BYTES = 1024 * 1024
TERMINAL_PROGRESS = frozenset({"started", "error", "idle"})
SUCCESS_STATUS = {
    "install": frozenset({"enabled", "cli_installed"}),
    "enable": frozenset({"enabled", "cli_installed"}),
    "disable": frozenset({"disabled"}),
    "remove": frozenset({"not_installed"}),
}


class ManagerError(RuntimeError):
    """A bounded manager failure safe to report without raw response data."""


def _exact_object(value: Any, required: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != required:
        raise ManagerError("invalid lifecycle request")
    return value


def _parse_request(payload: bytes) -> tuple[str, str]:
    if not payload or len(payload) > MAX_REQUEST_BYTES or b"\0" in payload:
        raise ManagerError("invalid lifecycle request")
    try:
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ManagerError("invalid lifecycle request") from exc
    value = _exact_object(value, {"schemaVersion", "action", "extensionId"})
    action = value.get("action")
    extension_id = value.get("extensionId")
    if value.get("schemaVersion") != SCHEMA_VERSION or action not in ALLOWED_ACTIONS:
        raise ManagerError("invalid lifecycle request")
    if not isinstance(extension_id, str) or SERVICE_ID.fullmatch(extension_id) is None:
        raise ManagerError("invalid extension id")
    return action, extension_id


def _read_env(env_path: pathlib.Path) -> dict[str, str]:
    if not env_path.is_absolute() or env_path == pathlib.Path("/"):
        raise ManagerError("invalid ODS environment path")
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(env_path, flags)
    except OSError as exc:
        raise ManagerError("ODS environment is unavailable") from exc
    try:
        info = os.fstat(descriptor)
        current = env_path.lstat()
        if (
            not stat.S_ISREG(info.st_mode)
            or stat.S_ISLNK(current.st_mode)
            or info.st_nlink != 1
            or info.st_uid != os.getuid()
            or info.st_mode & 0o022
            or info.st_size > 2 * 1024 * 1024
            or (info.st_dev, info.st_ino) != (current.st_dev, current.st_ino)
        ):
            raise ManagerError("unsafe ODS environment file")
        payload = bytearray()
        while len(payload) <= 2 * 1024 * 1024:
            piece = os.read(descriptor, min(65536, 2 * 1024 * 1024 + 1 - len(payload)))
            if not piece:
                break
            payload.extend(piece)
    finally:
        os.close(descriptor)
    if len(payload) > 2 * 1024 * 1024 or b"\0" in payload:
        raise ManagerError("unsafe ODS environment file")
    try:
        lines = bytes(payload).decode("utf-8").splitlines()
    except UnicodeDecodeError as exc:
        raise ManagerError("ODS environment is unreadable") from exc
    values: dict[str, str] = {}
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, raw = stripped.split("=", 1)
        key = key.strip()
        if re.fullmatch(r"[A-Z][A-Z0-9_]{0,127}", key) is None:
            continue
        if key in values:
            raise ManagerError("ODS environment contains duplicate keys")
        value = raw.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        values[key] = value
    return values


def _read_env_key(values: dict[str, str], name: str) -> str:
    value = values.get(name, "")
    if HEX_KEY.fullmatch(value) is None:
        raise ManagerError("ODS dashboard credential is unavailable")
    return value


def _request_json(
    *, port: int, credential: str, method: str, path: str, timeout: float
) -> tuple[int, dict[str, Any]]:
    if method not in {"GET", "POST", "DELETE"} or not path.startswith("/api/extensions/"):
        raise ManagerError("invalid internal ODS request")
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    response: http.client.HTTPResponse | None = None
    try:
        connection.request(
            method,
            path,
            body=b"{}" if method == "POST" else None,
            headers={
                "Authorization": f"Bearer {credential}",
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
        )
        response = connection.getresponse()
        status = int(response.status)
        content_type = response.headers.get_content_type()
        declared = response.headers.get("Content-Length")
        if declared is not None and (not declared.isdigit() or int(declared) > MAX_RESPONSE_BYTES):
            raise ManagerError("ODS extension API response is oversized")
        payload = response.read(MAX_RESPONSE_BYTES + 1)
    except (TimeoutError, OSError, http.client.HTTPException) as exc:
        raise ManagerError("ODS extension API is unavailable") from exc
    finally:
        if response is not None:
            response.close()
        connection.close()
    if len(payload) > MAX_RESPONSE_BYTES or content_type != "application/json":
        raise ManagerError("ODS extension API returned an invalid response")
    try:
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ManagerError("ODS extension API returned invalid JSON") from exc
    if not isinstance(value, dict):
        raise ManagerError("ODS extension API returned an invalid object")
    return status, value


def _configuration_keys(detail: dict[str, Any]) -> tuple[list[str], list[str]]:
    required: list[str] = []
    optional: list[str] = []
    classifications: dict[str, bool] = {}
    env_vars = detail.get("env_vars", [])
    if not isinstance(env_vars, list) or len(env_vars) > 128:
        raise ManagerError("extension configuration metadata is invalid")
    for item in env_vars:
        if not isinstance(item, dict):
            raise ManagerError("extension configuration metadata is invalid")
        key = item.get("key")
        if not isinstance(key, str) or re.fullmatch(r"[A-Z][A-Z0-9_]{0,127}", key) is None:
            raise ManagerError("extension configuration metadata is invalid")
        is_required = item.get("required") is True
        if key in classifications and classifications[key] != is_required:
            raise ManagerError("extension configuration metadata is ambiguous")
        classifications[key] = is_required
        destination = required if is_required else optional
        if key not in destination:
            destination.append(key)
    return sorted(required), sorted(optional)


def _bounded_status(value: Any) -> str:
    allowed = {
        "enabled", "cli_installed", "disabled", "stopped", "unhealthy",
        "installing", "setting_up", "error", "not_installed", "incompatible",
    }
    if not isinstance(value, str) or value not in allowed:
        raise ManagerError("extension status is invalid")
    return value


def _detail(port: int, credential: str, extension_id: str) -> dict[str, Any]:
    encoded = urllib.parse.quote(extension_id, safe="")
    status, value = _request_json(
        port=port,
        credential=credential,
        method="GET",
        path=f"/api/extensions/{encoded}",
        timeout=20,
    )
    if status != 200 or value.get("id") != extension_id:
        raise ManagerError("extension is not present in the ODS catalog")
    _bounded_status(value.get("status"))
    return value


def _public_result(
    *,
    action: str,
    extension_id: str,
    outcome: str,
    previous_status: str,
    current_status: str,
    changed: bool,
    external_effect: bool,
    required_configuration: list[str],
    optional_configuration: list[str],
    missing_configuration: list[str],
    rollback_attempted: bool = False,
    rollback_succeeded: bool | None = None,
) -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "kind": KIND,
        "action": action,
        "extensionId": extension_id,
        "outcome": outcome,
        "previousStatus": previous_status,
        "currentStatus": current_status,
        "changed": changed,
        "externalEffectOccurred": external_effect,
        "requiredConfiguration": required_configuration,
        "optionalConfiguration": optional_configuration,
        "missingConfiguration": missing_configuration,
        "rollback": {
            "attempted": rollback_attempted,
            "succeeded": rollback_succeeded,
        },
        "boundary": BOUNDARY,
    }


def _wait_for_status(
    *, port: int, credential: str, extension_id: str, expected: frozenset[str], deadline: float
) -> str:
    last_status = "not_installed"
    while time.monotonic() < deadline:
        detail = _detail(port, credential, extension_id)
        last_status = _bounded_status(detail.get("status"))
        if last_status in expected or last_status in {"error", "unhealthy", "incompatible"}:
            return last_status
        time.sleep(1.0)
    return last_status


def _mutate(
    *, port: int, credential: str, action: str, extension_id: str, previous: str
) -> None:
    encoded = urllib.parse.quote(extension_id, safe="")
    if action == "install":
        method, suffix = "POST", "/install"
    elif action == "enable":
        # Dependency changes must be separate exact owner-approved plans.
        method, suffix = "POST", "/enable?auto_enable_deps=false"
    elif action == "disable":
        method, suffix = "POST", "/disable?include_data_info=false"
    elif action == "remove":
        method, suffix = "DELETE", "?include_data_info=false"
    else:
        raise ManagerError("unsupported lifecycle action")
    status, _value = _request_json(
        port=port,
        credential=credential,
        method=method,
        path=f"/api/extensions/{encoded}{suffix}",
        timeout=120,
    )
    if status not in {200, 202}:
        # Idempotency is determined from the pre-mutation catalog state, not
        # from error strings returned by the internal API.
        raise ManagerError(f"ODS rejected extension {action} from state {previous}")


def _execute(
    *, env_path: pathlib.Path, port: int, action: str, extension_id: str
) -> dict[str, Any]:
    values = _read_env(env_path)
    credential = _read_env_key(values, "DASHBOARD_API_KEY")
    before = _detail(port, credential, extension_id)
    previous_status = _bounded_status(before.get("status"))
    required, optional = _configuration_keys(before)
    missing = [key for key in required if not values.get(key)]

    if action == "inspect":
        return _public_result(
            action=action,
            extension_id=extension_id,
            outcome="ready" if not missing else "blocked",
            previous_status=previous_status,
            current_status=previous_status,
            changed=False,
            external_effect=False,
            required_configuration=required,
            optional_configuration=optional,
            missing_configuration=missing,
        )

    idempotent = {
        "install": previous_status in {"enabled", "cli_installed", "disabled", "stopped"},
        "enable": previous_status in {"enabled", "cli_installed"},
        "disable": previous_status in {"disabled", "not_installed"},
        "remove": previous_status == "not_installed",
    }[action]
    if idempotent:
        return _public_result(
            action=action,
            extension_id=extension_id,
            outcome="noop",
            previous_status=previous_status,
            current_status=previous_status,
            changed=False,
            external_effect=False,
            required_configuration=required,
            optional_configuration=optional,
            missing_configuration=missing,
        )
    if action in {"install", "enable"} and missing:
        return _public_result(
            action=action,
            extension_id=extension_id,
            outcome="blocked",
            previous_status=previous_status,
            current_status=previous_status,
            changed=False,
            external_effect=False,
            required_configuration=required,
            optional_configuration=optional,
            missing_configuration=missing,
        )
    transition_allowed = {
        "install": previous_status == "not_installed",
        "enable": previous_status == "disabled",
        "disable": previous_status in {"enabled", "cli_installed"},
        "remove": previous_status == "disabled",
    }[action]
    if not transition_allowed:
        return _public_result(
            action=action,
            extension_id=extension_id,
            outcome="blocked",
            previous_status=previous_status,
            current_status=previous_status,
            changed=False,
            external_effect=False,
            required_configuration=required,
            optional_configuration=optional,
            missing_configuration=missing,
        )

    current_status = previous_status
    try:
        _mutate(
            port=port,
            credential=credential,
            action=action,
            extension_id=extension_id,
            previous=previous_status,
        )
        current_status = _wait_for_status(
            port=port,
            credential=credential,
            extension_id=extension_id,
            expected=SUCCESS_STATUS[action],
            deadline=time.monotonic() + (600 if action == "install" else 120),
        )
    except ManagerError:
        # A timeout or unavailable response can happen after the internal API
        # accepted the request. Reconcile from a fresh read and conservatively
        # report that an external effect was attempted.
        try:
            current_status = _bounded_status(
                _detail(port, credential, extension_id).get("status")
            )
        except ManagerError:
            current_status = previous_status
    succeeded = current_status in SUCCESS_STATUS[action]
    rollback_attempted = False
    rollback_succeeded: bool | None = None
    if not succeeded and action in {"install", "enable", "disable"}:
        rollback_attempted = True
        try:
            observed = _bounded_status(_detail(port, credential, extension_id).get("status"))
            if action == "install":
                if observed in {"enabled", "cli_installed", "stopped", "unhealthy", "error"}:
                    _mutate(
                        port=port,
                        credential=credential,
                        action="disable",
                        extension_id=extension_id,
                        previous=observed,
                    )
                    observed = _wait_for_status(
                        port=port,
                        credential=credential,
                        extension_id=extension_id,
                        expected=frozenset({"disabled"}),
                        deadline=time.monotonic() + 120,
                    )
                if observed == "disabled":
                    _mutate(
                        port=port,
                        credential=credential,
                        action="remove",
                        extension_id=extension_id,
                        previous=observed,
                    )
                rollback_expected = frozenset({"not_installed"})
            elif action == "enable" and observed in {
                "enabled", "cli_installed", "stopped", "unhealthy", "error",
            }:
                _mutate(
                    port=port,
                    credential=credential,
                    action="disable",
                    extension_id=extension_id,
                    previous=observed,
                )
                rollback_expected = frozenset({"disabled"})
            elif action == "disable" and observed == "disabled":
                _mutate(
                    port=port,
                    credential=credential,
                    action="enable",
                    extension_id=extension_id,
                    previous=observed,
                )
                rollback_expected = frozenset({"enabled", "cli_installed"})
            else:
                rollback_expected = frozenset({previous_status})
            rolled_back_status = _wait_for_status(
                port=port,
                credential=credential,
                extension_id=extension_id,
                expected=rollback_expected,
                deadline=time.monotonic() + 120,
            )
            rollback_succeeded = rolled_back_status in rollback_expected
            current_status = rolled_back_status
        except ManagerError:
            rollback_succeeded = False
    return _public_result(
        action=action,
        extension_id=extension_id,
        outcome="succeeded" if succeeded else "failed",
        previous_status=previous_status,
        current_status=current_status,
        changed=current_status != previous_status,
        external_effect=True,
        required_configuration=required,
        optional_configuration=optional,
        missing_configuration=[],
        rollback_attempted=rollback_attempted,
        rollback_succeeded=rollback_succeeded,
    )


def _error_result(action: str, extension_id: str) -> dict[str, Any]:
    return _public_result(
        action=action if action in ALLOWED_ACTIONS else "inspect",
        extension_id=extension_id if SERVICE_ID.fullmatch(extension_id or "") else "invalid",
        outcome="failed",
        previous_status="not_installed",
        current_status="not_installed",
        changed=False,
        external_effect=False,
        required_configuration=[],
        optional_configuration=[],
        missing_configuration=[],
    )


def _serve_connection(
    connection: socket.socket, *, expected_uid: int, env_path: pathlib.Path, port: int
) -> None:
    action = "inspect"
    extension_id = "invalid"
    try:
        peer = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
        _pid, uid, _gid = struct.unpack("3i", peer)
        if uid != expected_uid:
            raise ManagerError("unauthorized lifecycle peer")
        connection.settimeout(15)
        chunks = bytearray()
        while len(chunks) <= MAX_REQUEST_BYTES:
            piece = connection.recv(min(1024, MAX_REQUEST_BYTES + 1 - len(chunks)))
            if not piece:
                break
            chunks.extend(piece)
            if b"\n" in piece:
                break
        if b"\n" not in chunks or chunks.count(b"\n") != 1 or not chunks.endswith(b"\n"):
            raise ManagerError("invalid lifecycle request framing")
        action, extension_id = _parse_request(bytes(chunks[:-1]))
        result = _execute(
            env_path=env_path,
            port=port,
            action=action,
            extension_id=extension_id,
        )
    except (ManagerError, OSError, ValueError, TypeError):
        result = _error_result(action, extension_id)
    payload = (json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n").encode()
    connection.sendall(payload)


def serve(socket_path: pathlib.Path, env_path: pathlib.Path, port: int) -> int:
    if (
        not socket_path.is_absolute()
        or socket_path.parent != pathlib.Path("/run/ods-pixel-manager")
        or socket_path.name != "extension-manager.sock"
        or not 1 <= port <= 65535
    ):
        raise ManagerError("invalid lifecycle server configuration")
    broker_uid = pwd.getpwnam("pixel-ops-broker").pw_uid
    parent = socket_path.parent
    info = parent.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_mode & 0o007:
        raise ManagerError("unsafe lifecycle socket directory")
    if socket_path.exists() or socket_path.is_symlink():
        info = socket_path.lstat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
            raise ManagerError("unsafe existing lifecycle socket")
        socket_path.unlink()
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        listener.bind(str(socket_path))
        os.chmod(socket_path, 0o660)
        listener.listen(8)
        while True:
            connection, _address = listener.accept()
            with connection:
                _serve_connection(
                    connection,
                    expected_uid=broker_uid,
                    env_path=env_path,
                    port=port,
                )
    finally:
        listener.close()
        try:
            socket_path.unlink()
        except FileNotFoundError:
            pass


def client(socket_path: pathlib.Path, action: str, extension_id: str) -> int:
    if (
        socket_path != pathlib.Path("/run/ods-pixel-manager/extension-manager.sock")
        or action not in ALLOWED_ACTIONS
        or SERVICE_ID.fullmatch(extension_id) is None
    ):
        raise ManagerError("invalid lifecycle client request")
    request = {
        "schemaVersion": SCHEMA_VERSION,
        "action": action,
        "extensionId": extension_id,
    }
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.settimeout(900)
    try:
        connection.connect(str(socket_path))
        connection.sendall((json.dumps(request, separators=(",", ":")) + "\n").encode())
        chunks = bytearray()
        while len(chunks) <= MAX_RESPONSE_BYTES:
            piece = connection.recv(min(65536, MAX_RESPONSE_BYTES + 1 - len(chunks)))
            if not piece:
                break
            chunks.extend(piece)
    finally:
        connection.close()
    if len(chunks) > MAX_RESPONSE_BYTES or chunks.count(b"\n") != 1 or not chunks.endswith(b"\n"):
        raise ManagerError("invalid lifecycle manager response")
    try:
        value = json.loads(bytes(chunks[:-1]).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ManagerError("invalid lifecycle manager response") from exc
    if not isinstance(value, dict) or value.get("schemaVersion") != SCHEMA_VERSION or value.get("kind") != KIND:
        raise ManagerError("invalid lifecycle manager response")
    sys.stdout.write(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")
    return 0


def main(argv: list[str]) -> int:
    try:
        if len(argv) == 5 and argv[1] == "serve":
            port = int(argv[4], 10)
            return serve(pathlib.Path(argv[2]), pathlib.Path(argv[3]), port)
        if len(argv) == 5 and argv[1] == "client":
            return client(pathlib.Path(argv[2]), argv[3], argv[4])
        raise ManagerError("usage: extension_manager.py serve SOCKET ENV PORT | client SOCKET ACTION ID")
    except (ManagerError, OSError, ValueError, KeyError):
        # The caller receives only a stable error. Credentials, local paths,
        # upstream bodies, and exception details never cross the boundary.
        sys.stderr.write("ODS extension lifecycle request failed\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
