"""Owner-authenticated, bounded proxy for Pixel-specific provider Settings."""

from __future__ import annotations

import json
import math

from fastapi import APIRouter, Depends, HTTPException, Request

from host_agent_client import (
    AgentHTTPError, AgentProtocolError, AgentUnavailable,
    async_request_json as request_agent_json,
)
from pixel_provider_public import normalize_public
from security import verify_api_key

router = APIRouter(tags=["pixel-providers"])
MAX_BYTES = 256 * 1024


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate-key")
        result[key] = value
    return result


def _float(raw):
    value = float(raw)
    if not math.isfinite(value):
        raise ValueError("nonfinite-number")
    return value


def _constant(_value):
    raise ValueError("nonfinite-number")


def _check_depth(text):
    # Limit parser nesting before json.loads, including on builds with a high
    # recursion limit. Brackets inside escaped JSON strings do not count.
    depth = 0
    quoted = escaped = False
    for char in text:
        if quoted:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                quoted = False
        elif char == '"':
            quoted = True
        elif char in "[{":
            depth += 1
            if depth > 32:
                raise ValueError("document-too-deep")
        elif char in "]}":
            depth -= 1
            if depth < 0:
                raise ValueError("invalid-nesting")


async def _body(request):
    raw = bytearray()
    async for chunk in request.stream():
        if len(raw) + len(chunk) > MAX_BYTES:
            raise HTTPException(413, "Provider configuration exceeds size limit")
        raw.extend(chunk)
    try:
        text = bytes(raw).decode("utf-8")
        _check_depth(text)
        value = json.loads(text, object_pairs_hook=_pairs,
                           parse_float=_float, parse_constant=_constant)
    except (ValueError, RecursionError):
        raise HTTPException(400, "Invalid provider configuration request") from None
    if (not isinstance(value, dict)
            or not {"expectedRevision", "document"} <= set(value) <= {"expectedRevision", "document", "credentialChanges"}
            or type(value["expectedRevision"]) is not int
            or not 0 <= value["expectedRevision"] < 2**53 - 1
            or not isinstance(value["document"], dict)
            or not isinstance(value.get("credentialChanges", {}), dict)
            or len(value.get("credentialChanges", {})) > 32):
        raise HTTPException(400, "Invalid provider configuration request")
    return value


async def _request(method, path, payload=None):
    try:
        raw = await request_agent_json(method, path, payload=payload, timeout=10)
    except AgentHTTPError as exc:
        code = exc.status_code if exc.status_code in (400, 409, 413, 503) else 502
        raise HTTPException(code, "Provider settings request failed") from None
    except AgentUnavailable:
        raise HTTPException(503, "Provider settings are unavailable") from None
    except AgentProtocolError:
        raise HTTPException(502, "Invalid provider settings response") from None
    try:
        configuration = normalize_public(raw)
    except (ValueError, TypeError, RecursionError):
        raise HTTPException(502, "Invalid provider settings response") from None
    return {
        "configuration": configuration,
        # Deliberately distinct from desired configuration.enabled. Persistence
        # alone must never claim an effective inference route or grant access.
        "runtime": {"status": "not-applied", "reason": "provider-runtime-not-integrated"},
    }


@router.get("/api/pixel/providers")
async def get_providers(_key: str = Depends(verify_api_key)):
    return await _request("GET", "/v1/pixel/providers")


@router.post("/api/pixel/providers/save")
async def save_providers(request: Request, _key: str = Depends(verify_api_key)):
    return await _request("POST", "/v1/pixel/providers/save", await _body(request))
