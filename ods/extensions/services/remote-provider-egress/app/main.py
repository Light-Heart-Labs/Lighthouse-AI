"""ODS remote-provider egress service.

The service is internal-only. It accepts the OpenAI-compatible paths LiteLLM
uses, validates generated route state against the shared policy contract, and
injects provider credentials from a private file at the final egress boundary.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, AsyncIterator, Mapping

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

from remote_provider.egress import (
    DEFAULT_MAX_BODY_BYTES,
    DEFAULT_SECRET_PATH,
    EgressError,
    load_route_state,
    prepare_upstream_request,
    provider_secret_status,
    read_provider_secret,
    route_from_state,
    validate_direct_provider_resolution,
)
from remote_provider.policy import DEFAULT_POLICY_PATH, load_policy


ROUTE_PATH = Path(
    os.environ.get(
        "ODS_REMOTE_PROVIDER_ROUTE_PATH",
        "/state/remote-provider/routing-state.json",
    )
)
POLICY_PATH = Path(
    os.environ.get("ODS_REMOTE_PROVIDER_POLICY_PATH", str(DEFAULT_POLICY_PATH))
)
SECRET_PATH = Path(
    os.environ.get("ODS_REMOTE_PROVIDER_API_KEY_FILE", str(DEFAULT_SECRET_PATH))
)
MAX_BODY_BYTES = int(
    os.environ.get("ODS_REMOTE_PROVIDER_MAX_BODY_BYTES", str(DEFAULT_MAX_BODY_BYTES))
)
UPSTREAM_TIMEOUT_SECONDS = float(
    os.environ.get("ODS_REMOTE_PROVIDER_UPSTREAM_TIMEOUT", "600")
)

app = FastAPI(title="ODS Remote Provider Egress", docs_url=None, redoc_url=None, openapi_url=None)

_HOP_BY_HOP_RESPONSE_HEADERS = {
    "connection",
    "content-encoding",
    "content-length",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}


def _safe_route_summary(route: dict[str, Any]) -> dict[str, Any]:
    return {
        "enabled": bool(route.get("enabled")),
        "mode": route.get("mode"),
        "transport": route.get("transport"),
        "provider": route.get("provider") if route.get("enabled") else None,
        "egress": route.get("egress"),
    }


def _load_route() -> dict[str, Any]:
    policy = load_policy(POLICY_PATH)
    return route_from_state(load_route_state(ROUTE_PATH), policy=policy)


def _error_response(exc: EgressError) -> JSONResponse:
    return JSONResponse(
        {
            "error": {
                "message": exc.message,
                "type": exc.code,
                "code": str(exc.status),
            }
        },
        status_code=exc.status,
    )


def _response_headers(headers: Mapping[str, str]) -> dict[str, str]:
    return {
        name: value
        for name, value in headers.items()
        if name.lower() not in _HOP_BY_HOP_RESPONSE_HEADERS
    }


@app.get("/health")
async def health() -> dict[str, Any]:
    secret = provider_secret_status(SECRET_PATH)
    try:
        route = _load_route()
    except EgressError as exc:
        return {
            "status": "degraded",
            "ready": False,
            "reason": exc.code,
            "route": None,
            "secret": secret,
        }
    if route.get("enabled") is not True:
        return {
            "status": "disabled",
            "ready": False,
            "reason": "remote_route_disabled",
            "route": _safe_route_summary(route),
            "secret": secret,
        }
    try:
        resolved_addresses = validate_direct_provider_resolution(route)
    except EgressError as exc:
        return {
            "status": "degraded",
            "ready": False,
            "reason": exc.code,
            "route": _safe_route_summary(route),
            "resolution": {"ok": False, "reason": exc.code},
            "secret": secret,
        }
    if route.get("transport") == "direct" and not secret["configured"]:
        return {
            "status": "degraded",
            "ready": False,
            "reason": "missing_provider_secret",
            "route": _safe_route_summary(route),
            "resolution": {"ok": True, "addressCount": len(resolved_addresses)},
            "secret": secret,
        }
    return {
        "status": "ok",
        "ready": True,
        "reason": "ready",
        "route": _safe_route_summary(route),
        "resolution": {"ok": True, "addressCount": len(resolved_addresses)},
        "secret": secret,
    }


@app.get("/v1/models")
async def list_models() -> Response:
    try:
        route = _load_route()
    except EgressError as exc:
        return _error_response(exc)
    if route.get("enabled") is not True:
        return _error_response(
            EgressError(503, "remote_route_disabled", "remote provider route is disabled")
        )
    provider = route["provider"]
    data = [
        {"id": "ods/current", "object": "model", "owned_by": "ods"},
        {"id": "default", "object": "model", "owned_by": "ods"},
        {"id": provider["model"], "object": "model", "owned_by": "remote-provider"},
    ]
    return JSONResponse({"object": "list", "data": data, "ods": _safe_route_summary(route)})


@app.api_route(
    "/{full_path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "CONNECT"],
)
async def forward(full_path: str, request: Request) -> Response:
    path = "/" + full_path
    try:
        route = _load_route()
        validate_direct_provider_resolution(route)
        secret = read_provider_secret(SECRET_PATH)
        upstream_request = prepare_upstream_request(
            method=request.method,
            path=path,
            headers=dict(request.headers),
            body=await request.body(),
            route=route,
            provider_secret=secret,
            max_body_bytes=MAX_BODY_BYTES,
        )
    except EgressError as exc:
        return _error_response(exc)

    client: httpx.AsyncClient = app.state.http
    ods_headers = {
        "X-ODS-Remote-Transport": str(route.get("transport") or ""),
        "X-ODS-Requested-Model": upstream_request.requested_model,
        "X-ODS-Provider-Model": upstream_request.provider_model,
    }
    try:
        if upstream_request.stream:
            req = client.build_request(
                upstream_request.method,
                upstream_request.url,
                content=upstream_request.content,
                headers=upstream_request.headers,
                timeout=UPSTREAM_TIMEOUT_SECONDS,
            )
            upstream = await client.send(req, stream=True)

            async def stream_body() -> AsyncIterator[bytes]:
                try:
                    async for chunk in upstream.aiter_bytes():
                        yield chunk
                finally:
                    await upstream.aclose()

            return StreamingResponse(
                stream_body(),
                status_code=upstream.status_code,
                media_type=upstream.headers.get("content-type", "text/event-stream"),
                headers={**_response_headers(upstream.headers), **ods_headers},
            )

        upstream = await client.request(
            upstream_request.method,
            upstream_request.url,
            content=upstream_request.content,
            headers=upstream_request.headers,
            timeout=UPSTREAM_TIMEOUT_SECONDS,
        )
    except httpx.TimeoutException:
        return _error_response(
            EgressError(504, "upstream_timeout", "remote provider timed out")
        )
    except httpx.HTTPError as exc:
        return _error_response(
            EgressError(
                502,
                "upstream_unavailable",
                f"remote provider unavailable: {exc}",
            )
        )
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        media_type=upstream.headers.get("content-type", "application/json"),
        headers={**_response_headers(upstream.headers), **ods_headers},
    )


@app.on_event("startup")
async def _startup() -> None:
    app.state.http = httpx.AsyncClient(follow_redirects=False)


@app.on_event("shutdown")
async def _shutdown() -> None:
    await app.state.http.aclose()
