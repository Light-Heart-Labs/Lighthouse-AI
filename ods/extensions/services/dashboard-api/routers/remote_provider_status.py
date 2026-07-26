"""Read-only remote-provider lifecycle status for Dashboard/CLI consumers."""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Mapping

import httpx
from fastapi import APIRouter, Depends, HTTPException

from config import DATA_DIR
from host_agent_client import (
    AgentHTTPError,
    AgentProtocolError,
    AgentUnavailable,
    async_request_json as async_request_agent_json,
)
from security import verify_api_key

logger = logging.getLogger(__name__)

router = APIRouter(tags=["remote-provider"])

ROUTE_STATE_SCHEMA = "ods.remote-routing-state.v1"
EGRESS_URL = os.environ.get("REMOTE_PROVIDER_EGRESS_URL", "http://remote-provider-egress:8091")
EGRESS_TIMEOUT_SECONDS = 3.0

_SAFE_PROVIDER_KEYS = {"capability", "baseUrl", "model", "transport"}
_SAFE_PROJECTION_KEYS = {"publicModel", "gateway", "egressBaseUrl", "consumerRoute"}
_SSH_SUPERVISOR_SCHEMA = "ods.remote-provider-ssh-supervisor-plan.v1"
_EGRESS_PROBE_SCHEMA = "ods.remote-provider-egress-probe.v1"
_EGRESS_ERROR_MESSAGES = {
    "invalid_route": "Remote provider route is invalid",
    "invalid_route_state": "Remote provider route state is invalid",
    "missing_provider_secret": "Remote provider secret is missing",
    "provider_http_error": "Remote provider probe returned an HTTP error",
    "provider_probe_too_large": "Remote provider probe response exceeded the safety limit",
    "provider_resolution_empty": "Remote provider DNS resolution returned no addresses",
    "provider_resolution_rejected": "Remote provider DNS resolution was rejected",
    "provider_unreachable": "Remote provider is unreachable",
    "remote_route_disabled": "Remote provider route is disabled",
    "route_policy_rejected": "Remote provider route was rejected by policy",
    "ssh_tunnel_not_ready": "SSH tunnel is not ready",
    "transport_probe_unavailable": "Remote provider test is unavailable for this transport",
}


def _state_path() -> Path:
    override = os.environ.get("ODS_REMOTE_PROVIDER_ROUTE_PATH")
    if override:
        return Path(override)
    return Path(DATA_DIR) / "remote-provider" / "routing-state.json"


def _safe_string_map(value: Any, keys: set[str]) -> dict[str, str]:
    if not isinstance(value, Mapping):
        return {}
    clean: dict[str, str] = {}
    for key in keys:
        item = value.get(key)
        if isinstance(item, str):
            clean[key] = item
    return clean


def _safe_text(value: Any, *, max_length: int) -> str:
    if not isinstance(value, str):
        return ""
    text = value.strip()
    if any(ord(char) < 32 or ord(char) == 127 for char in text):
        return ""
    return text[:max_length]


def _safe_int(value: Any) -> int | None:
    return value if type(value) is int else None


def _safe_probe_receipt(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, Mapping):
        return None
    resolution = value.get("resolution")
    clean_resolution = None
    if isinstance(resolution, Mapping):
        clean_resolution = {
            "ok": bool(resolution.get("ok")),
            "addressCount": _safe_int(resolution.get("addressCount")),
        }
    receipt: dict[str, Any] = {
        "schema": _safe_text(value.get("schema"), max_length=64),
        "ok": bool(value.get("ok")),
        "verifiedAt": _safe_text(value.get("verifiedAt"), max_length=64),
        "endpoint": _safe_text(value.get("endpoint"), max_length=32),
        "httpStatus": _safe_int(value.get("httpStatus")),
        "modelCount": _safe_int(value.get("modelCount")),
        "resolution": clean_resolution,
    }
    content_type = _safe_text(value.get("contentType"), max_length=128)
    if content_type:
        receipt["contentType"] = content_type
    return receipt


def _safe_route_status(value: Any) -> dict[str, Any]:
    status = value if isinstance(value, Mapping) else {}
    clean: dict[str, Any] = {
        "proven": bool(status.get("proven")),
        "reason": _safe_text(status.get("reason"), max_length=128) or "disabled",
    }
    last_probe = _safe_probe_receipt(status.get("lastProbe"))
    if last_probe is not None:
        clean["lastProbe"] = last_probe
    return clean


def _state_response(
    *,
    exists: bool,
    valid: bool,
    enabled: bool = False,
    errors: list[str] | None = None,
    mode: str | None = None,
    provider: Mapping[str, Any] | None = None,
    projection: Mapping[str, Any] | None = None,
    status: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "exists": exists,
        "valid": valid,
        "enabled": enabled,
        "mode": mode,
        "provider": _safe_string_map(provider, _SAFE_PROVIDER_KEYS) if enabled else None,
        "projection": _safe_string_map(projection, _SAFE_PROJECTION_KEYS),
        "status": _safe_route_status(status),
        "errors": errors or [],
    }


def _read_route_state() -> dict[str, Any]:
    path = _state_path()
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return _state_response(exists=False, valid=True)
    except OSError as exc:
        return _state_response(exists=True, valid=False, errors=[f"read failed: {exc}"])

    try:
        doc = json.loads(raw)
    except ValueError as exc:
        return _state_response(exists=True, valid=False, errors=[f"not valid JSON: {exc}"])
    if not isinstance(doc, Mapping):
        return _state_response(exists=True, valid=False, errors=["state root must be an object"])
    if doc.get("schema") != ROUTE_STATE_SCHEMA:
        return _state_response(exists=True, valid=False, errors=["unknown routing-state schema"])
    enabled = doc.get("enabled") is True
    provider = doc.get("provider")
    if enabled and not isinstance(provider, Mapping):
        return _state_response(
            exists=True,
            valid=False,
            enabled=True,
            errors=["enabled route is missing provider metadata"],
        )
    return _state_response(
        exists=True,
        valid=True,
        enabled=enabled,
        mode=str(doc.get("mode") or "cloud"),
        provider=provider,
        projection=doc.get("projection"),
        status=doc.get("status"),
    )


def _safe_secret_status(value: Any) -> dict[str, Any]:
    secret = value if isinstance(value, Mapping) else {}
    raw_bytes = secret.get("bytes")
    return {
        "configured": bool(secret.get("configured")),
        "bytes": raw_bytes if type(raw_bytes) is int or raw_bytes is None else None,
    }


def _safe_ssh_tunnel(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, Mapping):
        return None
    argv = value.get("argv")
    clean_argv: list[str] = []
    if isinstance(argv, list):
        for item in argv[:64]:
            text = _safe_text(item, max_length=256)
            if text:
                clean_argv.append(text)
    return {
        "name": _safe_text(value.get("name"), max_length=32),
        "listenHost": _safe_text(value.get("listenHost"), max_length=128),
        "listenPort": _safe_int(value.get("listenPort")),
        "targetHost": _safe_text(value.get("targetHost"), max_length=128),
        "targetPort": _safe_int(value.get("targetPort")),
        "argv": clean_argv,
    }


def _safe_ssh_supervisor_status(
    payload: Any,
    *,
    reachable: bool = True,
) -> dict[str, Any]:
    if not isinstance(payload, Mapping):
        return {
            "reachable": reachable,
            "valid": False,
            "schema": "",
            "status": "invalid",
            "ready": False,
            "readyToStart": False,
            "reason": "invalid_ssh_supervisor_status",
            "tunnelBaseUrl": None,
            "tunnels": [],
            "secrets": {
                "sshIdentity": {"configured": False, "bytes": None},
                "sshKnownHosts": {"configured": False, "bytes": None},
            },
            "missingSecrets": [],
        }
    tunnels: list[dict[str, Any]] = []
    raw_tunnels = payload.get("tunnels")
    if isinstance(raw_tunnels, list):
        tunnels = [
            tunnel
            for tunnel in (_safe_ssh_tunnel(item) for item in raw_tunnels[:8])
            if tunnel is not None
        ]
    missing = payload.get("missingSecrets")
    missing_secrets = [
        text
        for text in (
            _safe_text(item, max_length=64)
            for item in (missing[:8] if isinstance(missing, list) else [])
        )
        if text
    ]
    secrets = payload.get("secrets") if isinstance(payload.get("secrets"), Mapping) else {}
    schema = _safe_text(payload.get("schema"), max_length=80)
    return {
        "reachable": reachable,
        "valid": schema == _SSH_SUPERVISOR_SCHEMA,
        "schema": schema,
        "status": _safe_text(payload.get("status"), max_length=64) or "unknown",
        "ready": bool(payload.get("ready")),
        "readyToStart": bool(payload.get("readyToStart")),
        "reason": _safe_text(payload.get("reason"), max_length=128) or "unknown",
        "tunnelBaseUrl": _safe_text(payload.get("tunnelBaseUrl"), max_length=256) or None,
        "tunnels": tunnels,
        "secrets": {
            "sshIdentity": _safe_secret_status(secrets.get("sshIdentity")),
            "sshKnownHosts": _safe_secret_status(secrets.get("sshKnownHosts")),
        },
        "missingSecrets": missing_secrets,
    }


def _safe_egress_tunnel(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, Mapping):
        return None
    process = value.get("process")
    clean_process = None
    if isinstance(process, Mapping):
        clean_process = {
            "status": _safe_text(process.get("status"), max_length=64) or "unknown",
            "pid": _safe_int(process.get("pid")),
        }
    tunnel: dict[str, Any] = {
        "ok": bool(value.get("ok")),
        "ready": bool(value.get("ready")),
        "status": _safe_text(value.get("status"), max_length=64) or "unknown",
        "reason": _safe_text(value.get("reason"), max_length=128) or "unknown",
        "process": clean_process,
    }
    http_status = _safe_int(value.get("httpStatus"))
    if http_status is not None:
        tunnel["httpStatus"] = http_status
    error_type = _safe_text(value.get("errorType"), max_length=128)
    if error_type:
        tunnel["errorType"] = error_type
    return tunnel


async def _fetch_ssh_supervisor_status() -> dict[str, Any]:
    try:
        payload = await async_request_agent_json(
            "GET",
            "/v1/remote-provider/ssh-supervisor",
            timeout=5,
        )
    except AgentHTTPError as exc:
        logger.debug("remote-provider SSH supervisor status returned HTTP error: %s", exc)
        return _safe_ssh_supervisor_status(
            {
                "schema": _SSH_SUPERVISOR_SCHEMA,
                "status": "unavailable",
                "ready": False,
                "readyToStart": False,
                "reason": f"host_agent_http_{exc.status_code}",
                "tunnelBaseUrl": None,
                "tunnels": [],
                "secrets": {},
                "missingSecrets": [],
            },
            reachable=True,
        )
    except (AgentUnavailable, AgentProtocolError) as exc:
        logger.debug("remote-provider SSH supervisor status unavailable: %s", exc)
        return _safe_ssh_supervisor_status(
            {
                "schema": _SSH_SUPERVISOR_SCHEMA,
                "status": "unavailable",
                "ready": False,
                "readyToStart": False,
                "reason": "host_agent_unavailable",
                "tunnelBaseUrl": None,
                "tunnels": [],
                "secrets": {},
                "missingSecrets": [],
            },
            reachable=False,
        )
    return _safe_ssh_supervisor_status(payload)


def _sanitize_egress_health(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, Mapping):
        return {
            "reachable": True,
            "valid": False,
            "ready": False,
            "status": "invalid",
            "reason": "invalid_egress_health",
            "secret": {"configured": False, "bytes": None},
            "resolution": None,
            "tunnel": None,
        }
    resolution = payload.get("resolution")
    clean_resolution = None
    if isinstance(resolution, Mapping):
        clean_resolution = {
            "ok": bool(resolution.get("ok")),
            "reason": _safe_text(resolution.get("reason"), max_length=128),
            "addressCount": (
                resolution.get("addressCount")
                if type(resolution.get("addressCount")) is int
                else None
            ),
        }
    return {
        "reachable": True,
        "valid": True,
        "ready": bool(payload.get("ready")),
        "status": _safe_text(payload.get("status"), max_length=64) or "unknown",
        "reason": _safe_text(payload.get("reason"), max_length=128),
        "secret": _safe_secret_status(payload.get("secret")),
        "resolution": clean_resolution,
        "tunnel": _safe_egress_tunnel(payload.get("tunnel")),
    }


def _safe_egress_error(payload: Any, status_code: int) -> dict[str, str]:
    error = payload.get("error") if isinstance(payload, Mapping) else None
    if not isinstance(error, Mapping):
        error = {}
    error_type = _safe_text(error.get("type"), max_length=128) or "egress_probe_failed"
    return {
        "type": error_type,
        "message": _EGRESS_ERROR_MESSAGES.get(
            error_type,
            f"remote-provider egress returned HTTP {status_code}",
        ),
        "code": str(status_code),
    }


def _sanitize_egress_probe_response(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, Mapping):
        raise ValueError("invalid_egress_probe_response")
    schema = _safe_text(payload.get("schema"), max_length=80)
    probe = _safe_probe_receipt(payload.get("probe"))
    if schema != _EGRESS_PROBE_SCHEMA or probe is None:
        raise ValueError("invalid_egress_probe_response")
    return {
        "schema": schema,
        "ok": bool(payload.get("ok")),
        "transport": _safe_text(payload.get("transport"), max_length=32),
        "probe": probe,
        "tunnel": _safe_egress_tunnel(payload.get("tunnel")),
    }


async def _fetch_egress_health() -> dict[str, Any]:
    url = f"{EGRESS_URL.rstrip('/')}/health"
    try:
        async with httpx.AsyncClient(timeout=EGRESS_TIMEOUT_SECONDS) as client:
            response = await client.get(url)
    except (httpx.ConnectError, httpx.TimeoutException, httpx.NetworkError) as exc:
        logger.debug("remote-provider-egress health unavailable: %s", exc)
        return {
            "reachable": False,
            "valid": False,
            "ready": False,
            "status": "unreachable",
            "reason": "egress_unreachable",
            "secret": {"configured": False, "bytes": None},
            "resolution": None,
            "tunnel": None,
        }
    except httpx.HTTPError as exc:
        logger.debug("remote-provider-egress health request failed: %s", exc)
        return {
            "reachable": False,
            "valid": False,
            "ready": False,
            "status": "error",
            "reason": "egress_request_failed",
            "secret": {"configured": False, "bytes": None},
            "resolution": None,
            "tunnel": None,
        }

    if response.status_code >= 400:
        return {
            "reachable": True,
            "valid": False,
            "ready": False,
            "status": "error",
            "reason": f"egress_http_{response.status_code}",
            "secret": {"configured": False, "bytes": None},
            "resolution": None,
            "tunnel": None,
        }
    try:
        payload = response.json()
    except ValueError:
        payload = None
    return _sanitize_egress_health(payload)


async def _post_egress_probe() -> dict[str, Any]:
    url = f"{EGRESS_URL.rstrip('/')}/probe"
    try:
        async with httpx.AsyncClient(timeout=EGRESS_TIMEOUT_SECONDS) as client:
            response = await client.post(url)
    except (httpx.ConnectError, httpx.TimeoutException, httpx.NetworkError) as exc:
        logger.debug("remote-provider-egress probe unavailable: %s", exc)
        raise HTTPException(
            status_code=503,
            detail={
                "type": "egress_unreachable",
                "message": "Remote provider egress is unreachable",
                "code": "503",
            },
        ) from exc
    except httpx.HTTPError as exc:
        logger.debug("remote-provider-egress probe request failed: %s", exc)
        raise HTTPException(
            status_code=502,
            detail={
                "type": "egress_request_failed",
                "message": "Remote provider egress probe request failed",
                "code": "502",
            },
        ) from exc

    try:
        payload = response.json()
    except ValueError as exc:
        raise HTTPException(
            status_code=502,
            detail={
                "type": "invalid_egress_probe_response",
                "message": "Remote provider egress returned an invalid probe response",
                "code": "502",
            },
        ) from exc

    if response.status_code >= 400:
        raise HTTPException(
            status_code=response.status_code,
            detail=_safe_egress_error(payload, response.status_code),
        )
    try:
        return _sanitize_egress_probe_response(payload)
    except ValueError as exc:
        raise HTTPException(
            status_code=502,
            detail={
                "type": "invalid_egress_probe_response",
                "message": "Remote provider egress returned an invalid probe response",
                "code": "502",
            },
        ) from exc


def _overall_status(route_state: Mapping[str, Any], egress: Mapping[str, Any]) -> str:
    if not route_state.get("valid"):
        return "invalid"
    if route_state.get("enabled") is not True:
        return "disabled"
    if not egress.get("reachable") or not egress.get("ready"):
        return "degraded"
    return "ready"


@router.get("/api/remote-provider/status", dependencies=[Depends(verify_api_key)])
async def remote_provider_status() -> dict[str, Any]:
    """Return sanitized remote-provider status without mutating configuration."""
    route_state = _read_route_state()
    egress = await _fetch_egress_health()
    ssh_supervisor = await _fetch_ssh_supervisor_status()
    return {
        "status": _overall_status(route_state, egress),
        "routeState": route_state,
        "sshSupervisor": ssh_supervisor,
        "egress": egress,
        "capabilities": {
            "inference": bool(route_state.get("enabled")),
            "odsPeerLifecycle": False,
        },
        "availableActions": {
            "configure": True,
            "test": bool(route_state.get("enabled")),
            "disable": bool(route_state.get("enabled")),
            "remove": bool(route_state.get("exists")),
        },
    }


@router.post("/api/remote-provider/plan", dependencies=[Depends(verify_api_key)])
async def remote_provider_plan(payload: dict[str, Any]) -> dict[str, Any]:
    """Validate a remote-provider lifecycle request through the host agent."""
    try:
        return await async_request_agent_json(
            "POST",
            "/v1/remote-provider/plan",
            payload=payload,
            timeout=10,
        )
    except AgentHTTPError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    except AgentUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"Host agent unreachable: {exc}") from exc
    except AgentProtocolError as exc:
        raise HTTPException(status_code=502, detail=f"Invalid host agent response: {exc}") from exc


@router.post("/api/remote-provider/probe", dependencies=[Depends(verify_api_key)])
async def remote_provider_probe() -> dict[str, Any]:
    """Probe the configured remote provider through the internal egress boundary."""
    return await _post_egress_probe()


@router.post("/api/remote-provider/apply", dependencies=[Depends(verify_api_key)])
async def remote_provider_apply(payload: dict[str, Any]) -> dict[str, Any]:
    """Apply a remote-provider lifecycle request through the host agent."""
    try:
        return await async_request_agent_json(
            "POST",
            "/v1/remote-provider/apply",
            payload=payload,
            timeout=10,
        )
    except AgentHTTPError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    except AgentUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"Host agent unreachable: {exc}") from exc
    except AgentProtocolError as exc:
        raise HTTPException(status_code=502, detail=f"Invalid host agent response: {exc}") from exc
