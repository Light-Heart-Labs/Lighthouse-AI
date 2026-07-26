"""Read-only remote-provider lifecycle status for Dashboard/CLI consumers."""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Mapping

import httpx
from fastapi import APIRouter, Depends

from config import DATA_DIR
from security import verify_api_key

logger = logging.getLogger(__name__)

router = APIRouter(tags=["remote-provider"])

ROUTE_STATE_SCHEMA = "ods.remote-routing-state.v1"
EGRESS_URL = os.environ.get("REMOTE_PROVIDER_EGRESS_URL", "http://remote-provider-egress:8091")
EGRESS_TIMEOUT_SECONDS = 3.0

_SAFE_PROVIDER_KEYS = {"capability", "baseUrl", "model", "transport"}
_SAFE_PROJECTION_KEYS = {"publicModel", "gateway", "egressBaseUrl", "consumerRoute"}


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
        "status": {
            "proven": bool((status or {}).get("proven")),
            "reason": str((status or {}).get("reason") or "disabled"),
        },
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
        }
    resolution = payload.get("resolution")
    clean_resolution = None
    if isinstance(resolution, Mapping):
        clean_resolution = {
            "ok": bool(resolution.get("ok")),
            "reason": str(resolution.get("reason") or ""),
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
        "status": str(payload.get("status") or "unknown"),
        "reason": str(payload.get("reason") or ""),
        "secret": _safe_secret_status(payload.get("secret")),
        "resolution": clean_resolution,
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
        }
    try:
        payload = response.json()
    except ValueError:
        payload = None
    return _sanitize_egress_health(payload)


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
    return {
        "status": _overall_status(route_state, egress),
        "routeState": route_state,
        "egress": egress,
        "capabilities": {
            "inference": bool(route_state.get("enabled")),
            "odsPeerLifecycle": False,
        },
        "availableActions": {
            "configure": False,
            "test": bool(route_state.get("enabled")),
            "disable": bool(route_state.get("enabled")),
            "remove": bool(route_state.get("exists")),
        },
    }
