"""Remote-provider lifecycle probe helpers.

The host-agent owns lifecycle initiation; this module keeps the direct-provider
handshake small, stdlib-only, and testable without opening sockets.
"""

from __future__ import annotations

import json
import socket
from collections.abc import Callable, Mapping
from typing import Any
from urllib import error as urllib_error
from urllib import request as urllib_request

from .egress import EgressError, validate_direct_provider_resolution


DEFAULT_PROBE_TIMEOUT_SECONDS = 10.0
MAX_PROBE_RESPONSE_BYTES = 64 * 1024
UrlOpener = Callable[..., Any]


class ProbeError(Exception):
    """HTTP-friendly remote-provider probe failure."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = int(status)
        self.code = str(code)
        self.message = str(message)


def _models_url(base_url: str) -> str:
    base = base_url.rstrip("/")
    if base.endswith("/v1"):
        return f"{base}/models"
    return f"{base}/v1/models"


def _provider(route: Mapping[str, Any]) -> Mapping[str, Any]:
    provider = route.get("provider")
    if not isinstance(provider, Mapping):
        raise ProbeError(503, "invalid_route", "provider route is missing")
    return provider


def _read_probe_body(response: Any) -> bytes:
    body = response.read(MAX_PROBE_RESPONSE_BYTES + 1)
    if len(body) > MAX_PROBE_RESPONSE_BYTES:
        raise ProbeError(
            502,
            "provider_probe_too_large",
            "remote provider probe response exceeded the safety limit",
        )
    return body


def _model_count(body: bytes) -> int | None:
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    if not isinstance(payload, Mapping):
        return None
    models = payload.get("data")
    if not isinstance(models, list):
        return None
    return len(models)


def probe_direct_provider(
    route: Mapping[str, Any],
    *,
    provider_secret: str,
    resolver: Callable[..., list[tuple[Any, ...]]] = socket.getaddrinfo,
    opener: UrlOpener = urllib_request.urlopen,
    timeout: float = DEFAULT_PROBE_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """Probe an OpenAI-compatible direct provider without leaking credentials."""
    if route.get("enabled") is not True:
        raise ProbeError(503, "remote_route_disabled", "remote provider route is disabled")
    if route.get("transport") != "direct":
        raise ProbeError(
            501,
            "transport_probe_unavailable",
            "remote provider test probes require direct transport in this release",
        )
    secret = str(provider_secret or "").strip()
    if not secret:
        raise ProbeError(400, "missing_provider_secret", "provider secret is required")

    try:
        resolved_addresses = validate_direct_provider_resolution(route, resolver=resolver)
    except EgressError as exc:
        raise ProbeError(exc.status, exc.code, exc.message) from exc

    provider = _provider(route)
    request = urllib_request.Request(
        _models_url(str(provider.get("baseUrl") or "")),
        method="GET",
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {secret}",
            "User-Agent": "ODS remote-provider-probe",
        },
    )
    try:
        with opener(request, timeout=timeout) as response:
            status = int(getattr(response, "status", 200))
            body = _read_probe_body(response)
            content_type = str(response.headers.get("content-type", ""))
    except urllib_error.HTTPError as exc:
        raise ProbeError(
            int(exc.code),
            "provider_http_error",
            f"remote provider probe returned HTTP {int(exc.code)}",
        ) from exc
    except (TimeoutError, urllib_error.URLError, OSError) as exc:
        raise ProbeError(
            502,
            "provider_unreachable",
            f"remote provider probe failed: {exc}",
        ) from exc

    if status < 200 or status >= 300:
        raise ProbeError(
            status,
            "provider_http_error",
            f"remote provider probe returned HTTP {status}",
        )
    return {
        "ok": True,
        "status": status,
        "endpoint": "/v1/models",
        "contentType": content_type,
        "modelCount": _model_count(body),
        "resolution": {
            "ok": True,
            "addressCount": len(resolved_addresses),
        },
    }


__all__ = [
    "DEFAULT_PROBE_TIMEOUT_SECONDS",
    "MAX_PROBE_RESPONSE_BYTES",
    "ProbeError",
    "probe_direct_provider",
]
