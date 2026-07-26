"""Pure helpers for the remote-provider egress service.

The FastAPI service owns HTTP I/O; this module keeps the security-sensitive
request preparation small and easy to test without sockets.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from .policy import (
    DEFAULT_POLICY_PATH,
    INTERNAL_EGRESS_BASE_URL,
    PUBLIC_MODEL_ALIAS,
    PolicyError,
    load_policy,
    plan_route,
)


ROUTING_STATE_SCHEMA = "ods.remote-routing-state.v1"
FORWARD_PATHS = {
    "/v1/chat/completions": "POST",
    "/v1/completions": "POST",
    "/v1/responses": "POST",
}
DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024
DEFAULT_SECRET_PATH = Path("/state/remote-provider/secrets/provider-api-key")
HOP_BY_HOP_HEADERS = {
    "authorization",
    "connection",
    "content-length",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}


class EgressError(Exception):
    """HTTP-friendly egress preparation failure."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


@dataclass(frozen=True)
class UpstreamRequest:
    method: str
    url: str
    headers: dict[str, str]
    content: bytes
    requested_model: str
    provider_model: str
    stream: bool


def _disabled_route(mode: str = "cloud") -> dict[str, Any]:
    return {
        "schema": "ods.remote-provider-route.v1",
        "enabled": False,
        "mode": mode,
        "transport": None,
        "provider": None,
        "ssh": None,
        "egress": {
            "internalBaseUrl": INTERNAL_EGRESS_BASE_URL,
            "publicModel": PUBLIC_MODEL_ALIAS,
            "consumerRoute": "gateway",
        },
    }


def load_route_state(path: str | Path) -> dict[str, Any]:
    """Read generated remote routing state; missing means disabled."""
    state_path = Path(path)
    try:
        return json.loads(state_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {
            "schema": ROUTING_STATE_SCHEMA,
            "enabled": False,
            "mode": "cloud",
            "provider": None,
        }
    except (OSError, ValueError) as exc:
        raise EgressError(503, "invalid_route_state", str(exc)) from exc


def route_from_state(
    state: Mapping[str, Any],
    *,
    policy: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Validate generated routing-state metadata and return a public route."""
    if state.get("schema") != ROUTING_STATE_SCHEMA:
        raise EgressError(503, "invalid_route_state", "unknown routing-state schema")
    mode = str(state.get("mode") or "cloud")
    if state.get("enabled") is not True:
        return _disabled_route(mode)
    provider = state.get("provider")
    if not isinstance(provider, Mapping):
        raise EgressError(503, "invalid_route_state", "provider metadata is missing")
    transport = str(provider.get("transport") or "")
    if transport == "ssh":
        raise EgressError(
            503,
            "ssh_transport_deferred",
            "SSH transport requires the tunnel supervisor before egress can forward",
        )
    env = {
        "ODS_MODE": mode,
        "REMOTE_LLM_ENABLED": "true",
        "REMOTE_LLM_TRANSPORT": transport,
        "REMOTE_LLM_BASE_URL": str(provider.get("baseUrl") or ""),
        "REMOTE_LLM_MODEL": str(provider.get("model") or ""),
    }
    try:
        return plan_route(env, policy=policy or load_policy(DEFAULT_POLICY_PATH))
    except PolicyError as exc:
        raise EgressError(503, "route_policy_rejected", str(exc)) from exc


def read_provider_secret(path: str | Path) -> str:
    """Read a provider bearer token from a private file, if present."""
    secret_path = Path(path)
    try:
        value = secret_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""
    except OSError as exc:
        raise EgressError(503, "provider_secret_unreadable", str(exc)) from exc
    secret = value.strip()
    if any(ord(char) < 32 or ord(char) == 127 for char in secret):
        raise EgressError(
            503,
            "provider_secret_invalid",
            "provider secret contains control characters",
        )
    return secret


def provider_secret_status(path: str | Path) -> dict[str, Any]:
    """Return support-bundle-safe secret-file status."""
    secret_path = Path(path)
    try:
        stat = secret_path.stat()
    except FileNotFoundError:
        return {"configured": False, "path": str(secret_path), "bytes": 0}
    except OSError:
        return {"configured": False, "path": str(secret_path), "bytes": None}
    return {"configured": stat.st_size > 0, "path": str(secret_path), "bytes": stat.st_size}


def sanitize_forward_headers(
    headers: Mapping[str, str],
    *,
    provider_secret: str,
) -> dict[str, str]:
    """Strip client auth and hop-by-hop headers; add provider auth privately."""
    forwarded: dict[str, str] = {}
    for name, value in headers.items():
        lower = name.lower()
        if lower in HOP_BY_HOP_HEADERS:
            continue
        forwarded[name] = value
    forwarded["content-type"] = "application/json"
    if provider_secret:
        forwarded["authorization"] = f"Bearer {provider_secret}"
    return forwarded


def _join_openai_path(base_url: str, path: str) -> str:
    base = base_url.rstrip("/")
    suffix = path
    if suffix.startswith("/v1/"):
        suffix = suffix[len("/v1"):]
    elif suffix == "/v1":
        suffix = ""
    if suffix and not suffix.startswith("/"):
        suffix = f"/{suffix}"
    return f"{base}{suffix}"


def prepare_upstream_request(
    *,
    method: str,
    path: str,
    headers: Mapping[str, str],
    body: bytes,
    route: Mapping[str, Any],
    provider_secret: str,
    max_body_bytes: int = DEFAULT_MAX_BODY_BYTES,
) -> UpstreamRequest:
    """Validate and rewrite one OpenAI-compatible request for the provider."""
    required_method = FORWARD_PATHS.get(path)
    if required_method is None or method.upper() != required_method:
        raise EgressError(
            404,
            "not_forwarded",
            f"Path not served by remote-provider-egress: {path}",
        )
    if len(body) > max_body_bytes:
        raise EgressError(413, "payload_too_large", "request body exceeds limit")
    if route.get("enabled") is not True:
        raise EgressError(503, "remote_route_disabled", "remote provider route is disabled")
    if route.get("transport") != "direct":
        raise EgressError(
            503,
            "transport_unavailable",
            "remote provider transport is not available in this egress service",
        )
    if not provider_secret:
        raise EgressError(
            503,
            "missing_provider_secret",
            "provider secret file is missing or empty",
        )
    provider = route.get("provider")
    if not isinstance(provider, Mapping):
        raise EgressError(503, "invalid_route", "provider route is missing")
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise EgressError(400, "invalid_json", f"invalid JSON body: {exc}") from exc
    if not isinstance(payload, dict):
        raise EgressError(400, "invalid_json", "request body must be a JSON object")
    requested_model = str(payload.get("model") or PUBLIC_MODEL_ALIAS)
    provider_model = str(provider.get("model") or "")
    payload["model"] = provider_model
    content = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return UpstreamRequest(
        method=required_method,
        url=_join_openai_path(str(provider.get("baseUrl") or ""), path),
        headers=sanitize_forward_headers(headers, provider_secret=provider_secret),
        content=content,
        requested_model=requested_model,
        provider_model=provider_model,
        stream=bool(payload.get("stream")),
    )


__all__ = [
    "DEFAULT_MAX_BODY_BYTES",
    "DEFAULT_SECRET_PATH",
    "FORWARD_PATHS",
    "ROUTING_STATE_SCHEMA",
    "EgressError",
    "UpstreamRequest",
    "load_route_state",
    "prepare_upstream_request",
    "provider_secret_status",
    "read_provider_secret",
    "route_from_state",
    "sanitize_forward_headers",
]
