"""Server-sent service health events for operator automation."""

import asyncio
import hashlib
import json
import time
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, Query, Request
from fastapi.responses import StreamingResponse

from helpers import get_cached_services
from security import verify_api_key


router = APIRouter(tags=["events"])


class ServiceStateTracker:
    """Convert cached health snapshots into deduplicated state transitions."""

    def __init__(self) -> None:
        self._fingerprint: str | None = None
        self._states: dict[str, str] | None = None

    def observe(self, statuses: list, *, cache_ready: bool) -> dict | None:
        states = {
            str(service.id): str(service.status)
            for service in statuses
        }
        canonical = json.dumps(
            {"cache_ready": cache_ready, "states": states},
            sort_keys=True,
            separators=(",", ":"),
        )
        fingerprint = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:20]
        if fingerprint == self._fingerprint:
            return None

        changes = []
        if self._states is not None:
            for service_id in sorted(set(self._states) | set(states)):
                previous = self._states.get(service_id)
                current = states.get(service_id)
                if previous != current:
                    changes.append({
                        "id": service_id,
                        "from": previous,
                        "to": current or "removed",
                    })

        self._fingerprint = fingerprint
        self._states = states
        return {
            "id": fingerprint,
            "event": "services",
            "data": {
                "observed_at": datetime.now(timezone.utc).isoformat(),
                "cache_ready": cache_ready,
                "services": [
                    {"id": service_id, "status": states[service_id]}
                    for service_id in sorted(states)
                ],
                "changes": changes,
            },
        }


def format_sse(observation: dict) -> str:
    payload = json.dumps(observation["data"], sort_keys=True, separators=(",", ":"))
    return (
        f"id: {observation['id']}\n"
        f"event: {observation['event']}\n"
        f"data: {payload}\n\n"
    )


async def service_event_stream(
    request: Request,
    *,
    poll_seconds: float,
    heartbeat_seconds: float,
    last_event_id: str | None,
    max_events: int | None,
    service_ids: frozenset[str] | None,
):
    tracker = ServiceStateTracker()
    emitted = 0
    last_heartbeat = time.monotonic()

    while not await request.is_disconnected():
        cached = get_cached_services()
        statuses = cached or []
        if service_ids is not None:
            statuses = [
                service
                for service in statuses
                if str(service.id) in service_ids
            ]
        observation = tracker.observe(statuses, cache_ready=cached is not None)
        if observation is not None and observation["id"] != last_event_id:
            yield format_sse(observation)
            emitted += 1
            last_event_id = observation["id"]
            last_heartbeat = time.monotonic()
            if max_events is not None and emitted >= max_events:
                return
        elif time.monotonic() - last_heartbeat >= heartbeat_seconds:
            yield ": keep-alive\n\n"
            last_heartbeat = time.monotonic()
        await asyncio.sleep(poll_seconds)


@router.get("/api/events/services")
async def service_events(
    request: Request,
    poll_seconds: float = Query(2.0, ge=0.5, le=30.0),
    heartbeat_seconds: float = Query(15.0, ge=5.0, le=120.0),
    max_events: int | None = Query(None, ge=1, le=1000),
    service: list[str] | None = Query(None),
    last_event_id: str | None = Header(None, alias="Last-Event-ID"),
    api_key: str = Depends(verify_api_key),
):
    """Stream deduplicated service-status snapshots and transitions as SSE."""
    stream = service_event_stream(
        request,
        poll_seconds=poll_seconds,
        heartbeat_seconds=heartbeat_seconds,
        last_event_id=last_event_id,
        max_events=max_events,
        service_ids=frozenset(service) if service else None,
    )
    return StreamingResponse(
        stream,
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
