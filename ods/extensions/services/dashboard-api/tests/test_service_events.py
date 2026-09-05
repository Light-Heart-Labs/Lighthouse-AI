"""Tests for the authenticated service-health event stream."""

import json
from types import SimpleNamespace

import pytest

from routers.events import ServiceStateTracker, format_sse, service_event_stream


def _service(service_id, status, response_time_ms=1):
    return SimpleNamespace(id=service_id, status=status, response_time_ms=response_time_ms)


def _event_data(event_text):
    data_line = next(line for line in event_text.splitlines() if line.startswith("data: "))
    return json.loads(data_line.removeprefix("data: "))


def test_tracker_emits_only_state_changes_and_reports_transitions():
    tracker = ServiceStateTracker()

    initial = tracker.observe([_service("api", "healthy", 10)], cache_ready=True)
    latency_only = tracker.observe([_service("api", "healthy", 900)], cache_ready=True)
    changed = tracker.observe(
        [_service("api", "unhealthy"), _service("worker", "healthy")],
        cache_ready=True,
    )

    assert initial["data"]["changes"] == []
    assert latency_only is None
    assert changed["data"]["changes"] == [
        {"id": "api", "from": "healthy", "to": "unhealthy"},
        {"id": "worker", "from": None, "to": "healthy"},
    ]


def test_tracker_reports_removed_services_and_cache_readiness():
    tracker = ServiceStateTracker()
    waiting = tracker.observe([], cache_ready=False)
    ready = tracker.observe([_service("api", "healthy")], cache_ready=True)
    removed = tracker.observe([], cache_ready=True)

    assert waiting["data"]["cache_ready"] is False
    assert ready["data"]["changes"] == [
        {"id": "api", "from": None, "to": "healthy"},
    ]
    assert removed["data"]["changes"] == [
        {"id": "api", "from": "healthy", "to": "removed"},
    ]


def test_sse_format_has_resumable_id_event_and_compact_json():
    observation = ServiceStateTracker().observe(
        [_service("api", "healthy")],
        cache_ready=True,
    )

    rendered = format_sse(observation)

    assert rendered.startswith(f"id: {observation['id']}\nevent: services\n")
    assert rendered.endswith("\n\n")
    assert _event_data(rendered)["services"] == [{"id": "api", "status": "healthy"}]


@pytest.mark.asyncio
async def test_stream_resumes_after_last_event_id_and_waits_for_a_change(monkeypatch):
    snapshots = iter([
        [_service("api", "healthy")],
        [_service("api", "unhealthy")],
    ])
    monkeypatch.setattr("routers.events.get_cached_services", lambda: next(snapshots))
    previous = ServiceStateTracker().observe(
        [_service("api", "healthy")],
        cache_ready=True,
    )

    class ConnectedRequest:
        async def is_disconnected(self):
            return False

    stream = service_event_stream(
        ConnectedRequest(),
        poll_seconds=0,
        heartbeat_seconds=15,
        last_event_id=previous["id"],
        max_events=1,
        service_ids=None,
    )
    resumed = await anext(stream)

    assert _event_data(resumed)["changes"] == [
        {"id": "api", "from": "healthy", "to": "unhealthy"},
    ]


def test_http_stream_can_emit_one_bounded_snapshot(test_client, monkeypatch):
    monkeypatch.setattr(
        "routers.events.get_cached_services",
        lambda: [_service("dashboard-api", "healthy"), _service("llama-server", "starting")],
    )

    response = test_client.get(
        "/api/events/services?max_events=1",
        headers=test_client.auth_headers,
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.headers["cache-control"] == "no-cache"
    assert response.headers["x-accel-buffering"] == "no"
    assert "event: services" in response.text
    assert _event_data(response.text)["services"] == [
        {"id": "dashboard-api", "status": "healthy"},
        {"id": "llama-server", "status": "starting"},
    ]


def test_http_stream_can_scope_snapshots_to_repeated_service_filters(
    test_client,
    monkeypatch,
):
    monkeypatch.setattr(
        "routers.events.get_cached_services",
        lambda: [
            _service("dashboard-api", "healthy"),
            _service("llama-server", "starting"),
            _service("open-webui", "healthy"),
        ],
    )

    response = test_client.get(
        "/api/events/services?max_events=1&service=open-webui&service=llama-server",
        headers=test_client.auth_headers,
    )

    assert response.status_code == 200
    assert _event_data(response.text)["services"] == [
        {"id": "llama-server", "status": "starting"},
        {"id": "open-webui", "status": "healthy"},
    ]


def test_http_stream_requires_authentication(test_client):
    response = test_client.get("/api/events/services?max_events=1")

    assert response.status_code == 401


def test_http_stream_validates_timing_and_event_bounds(test_client):
    response = test_client.get(
        "/api/events/services?poll_seconds=0.1&heartbeat_seconds=1&max_events=0",
        headers=test_client.auth_headers,
    )

    assert response.status_code == 422
