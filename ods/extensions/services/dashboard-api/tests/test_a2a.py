"""Boundary tests for the A2A v1 HTTP+JSON adapter."""

from unittest.mock import AsyncMock

from hermes_bridge import HermesReply, HermesUnavailable


def _a2a_headers(test_client):
    return {**test_client.auth_headers, "A2A-Version": "1.0"}


def test_agent_card_advertises_only_implemented_capabilities(test_client):
    response = test_client.get(
        "/.well-known/agent-card.json",
        headers={"host": "api.ods.local"},
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/a2a+json")
    card = response.json()
    assert card["supportedInterfaces"] == [
        {
            "url": "http://api.ods.local/a2a/v1",
            "protocolBinding": "HTTP+JSON",
            "protocolVersion": "1.0",
        }
    ]
    assert card["capabilities"] == {
        "streaming": False,
        "pushNotifications": False,
        "extendedAgentCard": False,
    }
    assert card["securitySchemes"]["dashboardBearer"]["httpAuthSecurityScheme"]["scheme"] == "Bearer"
    assert card["securityRequirements"] == [
        {"schemes": {"dashboardBearer": {"list": []}}}
    ]


def test_send_message_requires_dashboard_bearer_token(test_client):
    response = test_client.post(
        "/a2a/v1/message:send",
        json={
            "message": {
                "messageId": "msg-unauthorized",
                "role": "ROLE_USER",
                "parts": [{"text": "hello"}],
            }
        },
    )

    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"


def test_send_message_maps_text_to_hermes_and_returns_direct_message(test_client, monkeypatch):
    submit = AsyncMock(return_value=HermesReply(session_id="hermes-1", text="Hello from ODS"))
    monkeypatch.setattr("routers.a2a.hermes_bridge.submit_prompt", submit)

    response = test_client.post(
        "/a2a/v1/message:send",
        headers=_a2a_headers(test_client),
        json={
            "message": {
                "messageId": "msg-1",
                "contextId": "context-1",
                "role": "ROLE_USER",
                "parts": [{"text": "Research local inference"}],
            }
        },
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/a2a+json")
    payload = response.json()
    assert set(payload) == {"message"}
    assert payload["message"]["role"] == "ROLE_AGENT"
    assert payload["message"]["contextId"] == "context-1"
    assert payload["message"]["parts"] == [{"text": "Hello from ODS", "mediaType": "text/plain"}]
    session_key, prompt = submit.await_args.args
    assert len(session_key) == 64
    assert prompt == "Research local inference"


def test_send_message_keeps_context_on_the_same_hermes_session(test_client, monkeypatch):
    submit = AsyncMock(return_value=HermesReply(session_id="hermes-1", text="ok"))
    monkeypatch.setattr("routers.a2a.hermes_bridge.submit_prompt", submit)
    base_message = {
        "contextId": "shared-context",
        "role": "ROLE_USER",
        "parts": [{"text": "hello"}],
    }

    for message_id in ("msg-1", "msg-2"):
        response = test_client.post(
            "/a2a/v1/message:send",
            headers=_a2a_headers(test_client),
            json={"message": {**base_message, "messageId": message_id}},
        )
        assert response.status_code == 200

    assert submit.await_args_list[0].args[0] == submit.await_args_list[1].args[0]


def test_send_message_generates_context_when_client_omits_it(test_client, monkeypatch):
    monkeypatch.setattr(
        "routers.a2a.hermes_bridge.submit_prompt",
        AsyncMock(return_value=HermesReply(session_id="hermes-1", text="ok")),
    )

    response = test_client.post(
        "/a2a/v1/message:send",
        headers=_a2a_headers(test_client),
        json={
            "message": {
                "messageId": "msg-new-context",
                "role": "ROLE_USER",
                "parts": [{"text": "hello"}],
            }
        },
    )

    context_id = response.json()["message"]["contextId"]
    assert response.status_code == 200
    assert isinstance(context_id, str) and context_id


def test_send_message_rejects_task_continuation_until_task_lifecycle_exists(test_client):
    response = test_client.post(
        "/a2a/v1/message:send",
        headers=_a2a_headers(test_client),
        json={
            "message": {
                "messageId": "msg-task",
                "taskId": "task-1",
                "role": "ROLE_USER",
                "parts": [{"text": "continue"}],
            }
        },
    )

    assert response.status_code == 400
    assert response.headers["content-type"].startswith("application/a2a+json")
    assert response.json()["error"]["details"][0]["reason"] == "UNSUPPORTED_OPERATION"
    assert "task lifecycle" in response.json()["error"]["message"].lower()


def test_send_message_rejects_non_text_parts_at_the_public_boundary(test_client):
    response = test_client.post(
        "/a2a/v1/message:send",
        headers=_a2a_headers(test_client),
        json={
            "message": {
                "messageId": "msg-file",
                "role": "ROLE_USER",
                "parts": [{"url": "https://example.test/file.pdf"}],
            }
        },
    )

    assert response.status_code == 400
    assert response.json()["error"]["details"][0]["reason"] == "CONTENT_TYPE_NOT_SUPPORTED"
    assert "text" in response.json()["error"]["message"].lower()


def test_send_message_rejects_oversized_request_before_hermes(test_client, monkeypatch):
    submit = AsyncMock(return_value=HermesReply(session_id="hermes-1", text="unused"))
    monkeypatch.setattr("routers.a2a.hermes_bridge.submit_prompt", submit)

    response = test_client.post(
        "/a2a/v1/message:send",
        headers=_a2a_headers(test_client),
        json={
            "message": {
                "messageId": "msg-large",
                "role": "ROLE_USER",
                "parts": [{"text": "x" * 70_000}],
            }
        },
    )

    assert response.status_code == 413
    assert response.json()["error"]["status"] == "RESOURCE_EXHAUSTED"
    submit.assert_not_awaited()


def test_send_message_surfaces_hermes_unavailability(test_client, monkeypatch):
    monkeypatch.setattr(
        "routers.a2a.hermes_bridge.submit_prompt",
        AsyncMock(side_effect=HermesUnavailable("offline")),
    )

    response = test_client.post(
        "/a2a/v1/message:send",
        headers=_a2a_headers(test_client),
        json={
            "message": {
                "messageId": "msg-offline",
                "role": "ROLE_USER",
                "parts": [{"text": "hello"}],
            }
        },
    )

    assert response.status_code == 503
    assert response.json()["error"]["message"] == "Hermes Agent is unavailable."


def test_send_message_rejects_unsupported_protocol_version(test_client):
    response = test_client.post(
        "/a2a/v1/message:send",
        headers={**test_client.auth_headers, "A2A-Version": "0.3"},
        json={
            "message": {
                "messageId": "msg-old-version",
                "role": "ROLE_USER",
                "parts": [{"text": "hello"}],
            }
        },
    )

    assert response.status_code == 400
    assert response.headers["content-type"].startswith("application/a2a+json")
    assert response.json()["error"]["details"][0]["reason"] == "VERSION_NOT_SUPPORTED"


def test_task_operations_are_truthful_for_a_direct_message_agent(test_client):
    headers = _a2a_headers(test_client)

    listed = test_client.get("/a2a/v1/tasks", headers=headers)
    missing = test_client.get("/a2a/v1/tasks/task-1", headers=headers)
    canceled = test_client.post("/a2a/v1/tasks/task-1:cancel", headers=headers)

    assert listed.status_code == 200
    assert listed.json() == {
        "tasks": [],
        "nextPageToken": "",
        "pageSize": 50,
        "totalSize": 0,
    }
    for response in (missing, canceled):
        assert response.status_code == 404
        assert response.json()["error"]["status"] == "NOT_FOUND"
        assert response.json()["error"]["details"][0]["reason"] == "TASK_NOT_FOUND"


def test_streaming_operation_matches_the_agent_card_capability(test_client):
    response = test_client.post(
        "/a2a/v1/message:stream",
        headers=_a2a_headers(test_client),
        json={},
    )

    assert response.status_code == 400
    assert response.json()["error"]["status"] == "FAILED_PRECONDITION"
    assert response.json()["error"]["details"][0]["reason"] == "UNSUPPORTED_OPERATION"


def test_optional_capability_routes_return_protocol_errors(test_client):
    headers = _a2a_headers(test_client)
    responses = (
        test_client.post("/a2a/v1/tasks/task-1:subscribe", headers=headers),
        test_client.post(
            "/a2a/v1/tasks/task-1/pushNotificationConfigs",
            headers=headers,
            json={},
        ),
        test_client.get("/a2a/v1/extendedAgentCard", headers=headers),
    )

    assert [response.status_code for response in responses] == [400, 400, 400]
    reasons = [response.json()["error"]["details"][0]["reason"] for response in responses]
    assert reasons == [
        "UNSUPPORTED_OPERATION",
        "PUSH_NOTIFICATION_NOT_SUPPORTED",
        "UNSUPPORTED_OPERATION",
    ]
