"""A2A v1 HTTP+JSON adapter for the ODS Hermes agent.

The pinned Hermes dashboard exposes a blocking prompt bridge, but it does not
expose durable tasks or safe cancellation.  This adapter therefore uses A2A's
direct ``Message`` response form and advertises no streaming or push support.
That keeps discovery truthful while making the existing agent reachable by
standards-aware clients.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import Mapping
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Security
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials

import hermes_bridge
from security import security_scheme, verify_api_key

router = APIRouter(tags=["a2a"])

A2A_MEDIA_TYPE = "application/a2a+json"
A2A_VERSION = "1.0"
MAX_MESSAGE_CHARS = 8000
MAX_REQUEST_BYTES = 64 * 1024
MAX_ID_CHARS = 256
MAX_PARTS = 64


def _interface_url(request: Request) -> str:
    return f"{str(request.base_url).rstrip('/')}/a2a/v1"


def _agent_card(request: Request) -> dict[str, Any]:
    return {
        "name": "ODS Hermes Agent",
        "description": "A private, locally hosted general-purpose agent powered by ODS and Hermes.",
        "supportedInterfaces": [
            {
                "url": _interface_url(request),
                "protocolBinding": "HTTP+JSON",
                "protocolVersion": A2A_VERSION,
            }
        ],
        "provider": {
            "url": "https://github.com/Osmantic/ODS",
            "organization": "Osmantic",
        },
        "version": "1.0.0",
        "documentationUrl": "https://github.com/Osmantic/ODS/blob/main/ods/docs/HERMES.md",
        "capabilities": {
            "streaming": False,
            "pushNotifications": False,
            "extendedAgentCard": False,
        },
        "securitySchemes": {
            "dashboardBearer": {
                "httpAuthSecurityScheme": {
                    "description": "ODS Dashboard API bearer token",
                    "scheme": "Bearer",
                    "bearerFormat": "opaque",
                }
            }
        },
        "securityRequirements": [
            {"schemes": {"dashboardBearer": {"list": []}}}
        ],
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["text/plain"],
        "skills": [
            {
                "id": "general-assistance",
                "name": "General assistance",
                "description": "Answer questions and perform locally configured Hermes agent workflows.",
                "tags": ["assistant", "local-ai", "tools"],
                "examples": ["Summarize this topic", "Research a technical question"],
            }
        ],
    }


def _message_text(payload: Any) -> tuple[str, str, str]:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="message must be an object.")

    message_id = payload.get("messageId")
    if not isinstance(message_id, str) or not message_id.strip():
        raise HTTPException(status_code=400, detail="message.messageId is required.")
    if len(message_id.strip()) > MAX_ID_CHARS:
        raise HTTPException(status_code=400, detail="message.messageId exceeds 256 characters.")
    if payload.get("role") != "ROLE_USER":
        raise HTTPException(status_code=400, detail="message.role must be ROLE_USER.")
    if payload.get("taskId"):
        raise HTTPException(
            status_code=409,
            detail="ODS does not expose an A2A task lifecycle yet; send a direct message without taskId.",
        )

    parts = payload.get("parts")
    if not isinstance(parts, list) or not parts:
        raise HTTPException(status_code=400, detail="message.parts must contain at least one text part.")
    if len(parts) > MAX_PARTS:
        raise HTTPException(status_code=413, detail="message.parts exceeds the 64-part limit.")

    text_parts: list[str] = []
    for part in parts:
        content_fields = {"text", "raw", "url", "data"}.intersection(part) if isinstance(part, dict) else set()
        if content_fields != {"text"} or not isinstance(part.get("text"), str):
            raise HTTPException(status_code=415, detail="ODS A2A currently accepts text parts only.")
        media_type = part.get("mediaType")
        if media_type not in (None, "", "text/plain"):
            raise HTTPException(status_code=415, detail="ODS A2A currently accepts text/plain parts only.")
        if part["text"].strip():
            text_parts.append(part["text"].strip())

    text = "\n\n".join(text_parts)
    if not text:
        raise HTTPException(status_code=400, detail="message text cannot be empty.")
    if len(text) > MAX_MESSAGE_CHARS:
        raise HTTPException(
            status_code=413,
            detail=f"message text exceeds the {MAX_MESSAGE_CHARS}-character limit.",
        )

    context_id = payload.get("contextId")
    if context_id is not None and (not isinstance(context_id, str) or not context_id.strip()):
        raise HTTPException(status_code=400, detail="message.contextId must be a non-empty string.")
    if isinstance(context_id, str) and len(context_id.strip()) > MAX_ID_CHARS:
        raise HTTPException(status_code=400, detail="message.contextId exceeds 256 characters.")
    return message_id.strip(), (context_id or str(uuid.uuid4())).strip(), text


def _session_key(api_key: str, context_id: str) -> str:
    identity = f"a2a:{api_key}:{context_id}".encode("utf-8")
    return hashlib.sha256(identity).hexdigest()


def _error_response(
    status_code: int,
    message: str,
    *,
    reason: str | None = None,
    headers: Mapping[str, str] | None = None,
) -> JSONResponse:
    details: list[dict[str, Any]] = []
    if reason:
        details.append(
            {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                "reason": reason,
                "domain": "a2a-protocol.org",
            }
        )
    status_name = {
        400: "INVALID_ARGUMENT",
        401: "UNAUTHENTICATED",
        403: "PERMISSION_DENIED",
        404: "NOT_FOUND",
        413: "RESOURCE_EXHAUSTED",
        502: "UNAVAILABLE",
        503: "UNAVAILABLE",
    }.get(status_code, "UNKNOWN")
    if reason in {
        "PUSH_NOTIFICATION_NOT_SUPPORTED",
        "UNSUPPORTED_OPERATION",
        "VERSION_NOT_SUPPORTED",
    }:
        status_name = "FAILED_PRECONDITION"
    return JSONResponse(
        {
            "error": {
                "code": status_code,
                "status": status_name,
                "message": message,
                "details": details,
            }
        },
        status_code=status_code,
        media_type=A2A_MEDIA_TYPE,
        headers=headers,
    )


async def _authorize_request(
    request: Request,
    credentials: HTTPAuthorizationCredentials,
) -> tuple[str | None, JSONResponse | None]:
    try:
        api_key = await verify_api_key(credentials)
    except HTTPException as exc:
        return None, _error_response(
            exc.status_code,
            str(exc.detail),
            headers=exc.headers,
        )

    version = (request.headers.get("A2A-Version") or "0.3").strip()
    if version != A2A_VERSION:
        return None, _error_response(
            400,
            f"A2A protocol version {version!r} is not supported; use {A2A_VERSION}.",
            reason="VERSION_NOT_SUPPORTED",
        )
    return api_key, None


@router.get("/.well-known/agent-card.json")
async def agent_card(request: Request) -> JSONResponse:
    """Public A2A discovery document; it never contains credentials."""
    return JSONResponse(_agent_card(request), media_type=A2A_MEDIA_TYPE)


@router.post("/a2a/v1/message:send")
async def send_message(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Security(security_scheme),
) -> JSONResponse:
    """Run one blocking A2A text turn through the existing Hermes bridge."""
    api_key, auth_error = await _authorize_request(request, credentials)
    if auth_error is not None:
        return auth_error
    assert api_key is not None

    body = await request.body()
    if len(body) > MAX_REQUEST_BYTES:
        return _error_response(413, "Request body exceeds the 64 KiB limit.")
    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return _error_response(400, "Request body must be valid JSON.")
    if not isinstance(payload, dict):
        return _error_response(400, "Request body must be a JSON object.")

    try:
        message_id, context_id, text = _message_text(payload.get("message"))

        if payload.get("tenant") not in (None, ""):
            raise HTTPException(status_code=400, detail="tenant is not configured for this A2A interface.")
        configuration = payload.get("configuration") or {}
        if not isinstance(configuration, dict):
            raise HTTPException(status_code=400, detail="configuration must be an object.")
        accepted_modes = configuration.get("acceptedOutputModes") or []
        if not isinstance(accepted_modes, list):
            raise HTTPException(status_code=400, detail="acceptedOutputModes must be a list.")
        if len(accepted_modes) > 16 or not all(isinstance(mode, str) for mode in accepted_modes):
            raise HTTPException(status_code=400, detail="acceptedOutputModes must contain at most 16 strings.")
        if accepted_modes and "text/plain" not in accepted_modes:
            return _error_response(
                400,
                "ODS A2A produces text/plain output only.",
                reason="CONTENT_TYPE_NOT_SUPPORTED",
            )
        if "taskPushNotificationConfig" in configuration:
            return _error_response(
                400,
                "ODS A2A does not support push notifications.",
                reason="PUSH_NOTIFICATION_NOT_SUPPORTED",
            )
    except HTTPException as exc:
        reason = None
        status_code = exc.status_code
        if status_code == 409:
            status_code = 400
            reason = "UNSUPPORTED_OPERATION"
        elif status_code == 415:
            status_code = 400
            reason = "CONTENT_TYPE_NOT_SUPPORTED"
        return _error_response(status_code, str(exc.detail), reason=reason)

    try:
        reply = await hermes_bridge.submit_prompt(_session_key(api_key, context_id), text)
    except hermes_bridge.HermesUnavailable:
        return _error_response(503, "Hermes Agent is unavailable.")
    except hermes_bridge.HermesBridgeError:
        return _error_response(502, "Hermes Agent could not complete the message.")

    response_message: dict[str, Any] = {
        "messageId": str(uuid.uuid4()),
        "contextId": context_id,
        "role": "ROLE_AGENT",
        "parts": [{"text": reply.text, "mediaType": "text/plain"}],
        "metadata": {"inReplyTo": message_id},
    }
    if reply.warning:
        response_message["metadata"]["warning"] = reply.warning
    return JSONResponse({"message": response_message}, media_type=A2A_MEDIA_TYPE)


@router.post("/a2a/v1/message:stream")
async def send_streaming_message(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Security(security_scheme),
) -> JSONResponse:
    _, auth_error = await _authorize_request(request, credentials)
    if auth_error is not None:
        return auth_error
    return _error_response(
        400,
        "ODS A2A does not support streaming messages.",
        reason="UNSUPPORTED_OPERATION",
    )


async def _unsupported_capability(
    request: Request,
    credentials: HTTPAuthorizationCredentials,
    *,
    message: str,
    reason: str,
) -> JSONResponse:
    _, auth_error = await _authorize_request(request, credentials)
    if auth_error is not None:
        return auth_error
    return _error_response(400, message, reason=reason)


@router.get("/a2a/v1/tasks")
async def list_tasks(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Security(security_scheme),
) -> JSONResponse:
    _, auth_error = await _authorize_request(request, credentials)
    if auth_error is not None:
        return auth_error
    raw_page_size = request.query_params.get("pageSize", "50")
    try:
        page_size = int(raw_page_size)
    except ValueError:
        return _error_response(400, "pageSize must be an integer from 1 to 100.")
    if not 1 <= page_size <= 100:
        return _error_response(400, "pageSize must be an integer from 1 to 100.")
    return JSONResponse(
        {"tasks": [], "nextPageToken": "", "pageSize": page_size, "totalSize": 0},
        media_type=A2A_MEDIA_TYPE,
    )


def _task_not_found(task_id: str) -> JSONResponse:
    return _error_response(
        404,
        f"Task with ID {task_id!r} was not found; ODS currently returns direct messages.",
        reason="TASK_NOT_FOUND",
    )


@router.get("/a2a/v1/tasks/{task_id}")
async def get_task(
    task_id: str,
    request: Request,
    credentials: HTTPAuthorizationCredentials = Security(security_scheme),
) -> JSONResponse:
    _, auth_error = await _authorize_request(request, credentials)
    if auth_error is not None:
        return auth_error
    return _task_not_found(task_id)


@router.post("/a2a/v1/tasks/{task_id}:cancel")
async def cancel_task(
    task_id: str,
    request: Request,
    credentials: HTTPAuthorizationCredentials = Security(security_scheme),
) -> JSONResponse:
    _, auth_error = await _authorize_request(request, credentials)
    if auth_error is not None:
        return auth_error
    return _task_not_found(task_id)


@router.post("/a2a/v1/tasks/{task_id}:subscribe")
async def subscribe_to_task(
    task_id: str,
    request: Request,
    credentials: HTTPAuthorizationCredentials = Security(security_scheme),
) -> JSONResponse:
    return await _unsupported_capability(
        request,
        credentials,
        message=f"ODS A2A does not support streaming task {task_id!r}.",
        reason="UNSUPPORTED_OPERATION",
    )


@router.api_route(
    "/a2a/v1/tasks/{task_id}/pushNotificationConfigs",
    methods=["GET", "POST"],
)
@router.api_route(
    "/a2a/v1/tasks/{task_id}/pushNotificationConfigs/{config_id}",
    methods=["GET", "DELETE"],
)
async def task_push_notifications_not_supported(
    task_id: str,
    request: Request,
    config_id: str | None = None,
    credentials: HTTPAuthorizationCredentials = Security(security_scheme),
) -> JSONResponse:
    return await _unsupported_capability(
        request,
        credentials,
        message=f"ODS A2A does not support push notifications for task {task_id!r}.",
        reason="PUSH_NOTIFICATION_NOT_SUPPORTED",
    )


@router.get("/a2a/v1/extendedAgentCard")
async def extended_agent_card_not_supported(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Security(security_scheme),
) -> JSONResponse:
    return await _unsupported_capability(
        request,
        credentials,
        message="ODS A2A does not expose an extended Agent Card.",
        reason="UNSUPPORTED_OPERATION",
    )
