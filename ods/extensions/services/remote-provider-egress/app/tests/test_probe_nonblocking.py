"""Regression tests for #2699 — /probe handler must not block the event loop.

These tests verify that the synchronous urllib probe call is run via
asyncio.to_thread() so concurrent inference requests are never frozen.
"""

from __future__ import annotations

import asyncio
import threading
import time
from pathlib import Path



# ---------------------------------------------------------------------------
# Path helpers — locate egress app/main.py relative to this file
# ---------------------------------------------------------------------------

APP_MAIN = (
    Path(__file__).resolve().parent.parent / "main.py"
)


# ---------------------------------------------------------------------------
# Tests for #2699
# ---------------------------------------------------------------------------


def test_probe_handler_uses_to_thread_not_direct_call() -> None:
    """Regression #2699: /probe must offload probe_route_response via asyncio.to_thread."""
    source = APP_MAIN.read_text(encoding="utf-8")
    assert "asyncio.to_thread(" in source, (
        "The /probe handler must offload probe_route_response via asyncio.to_thread() "
        "to avoid blocking the asyncio event loop."
    )


def test_asyncio_import_present_in_egress_main() -> None:
    """Regression #2699: asyncio must be imported in egress main.py."""
    source = APP_MAIN.read_text(encoding="utf-8")
    assert "import asyncio" in source, (
        "asyncio must be imported in egress/app/main.py for asyncio.to_thread() to work."
    )


def test_probe_route_response_not_directly_awaited() -> None:
    """Regression #2699: probe_route_response is sync and must never be directly awaited."""
    source = APP_MAIN.read_text(encoding="utf-8")
    assert "await probe_route_response(" not in source, (
        "probe_route_response is a synchronous function and must never be directly awaited. "
        "Use asyncio.to_thread(probe_route_response, ...) instead."
    )


def test_to_thread_does_not_block_concurrent_coroutine() -> None:
    """Regression #2699: a slow blocking probe offloaded via to_thread must not
    delay a concurrent coroutine that runs on the same event loop.
    """
    SLOW_PROBE_DELAY = 0.3   # seconds
    FAST_TASK_DELAY = 0.05   # seconds — finishes well before the probe

    results: list[str] = []
    probe_thread_ids: list[int] = []
    event_loop_thread_id = [0]

    def slow_blocking_probe() -> str:
        # Record which thread this ran on — must NOT be the event loop thread.
        probe_thread_ids.append(threading.get_ident())
        time.sleep(SLOW_PROBE_DELAY)
        return "probe_done"

    async def fast_concurrent_task() -> None:
        await asyncio.sleep(FAST_TASK_DELAY)
        results.append("fast_task_done")

    async def scenario() -> None:
        event_loop_thread_id[0] = threading.get_ident()

        # Offload the slow probe to a thread (mirrors the fix).
        slow_task = asyncio.create_task(asyncio.to_thread(slow_blocking_probe))
        fast_task = asyncio.create_task(fast_concurrent_task())

        # Wait for whichever finishes first.
        done, pending = await asyncio.wait(
            [fast_task, slow_task],
            return_when=asyncio.FIRST_COMPLETED,
        )

        assert fast_task in done, (
            "fast_concurrent_task must complete before the slow probe — "
            "if the event loop were blocked the fast task would be frozen too."
        )
        results.append("fast_task_won_the_race")

        # Clean up remaining tasks.
        for t in pending:
            await t

    asyncio.run(scenario())

    assert "fast_task_done" in results, "fast coroutine must have completed"
    assert "fast_task_won_the_race" in results, "fast coroutine must finish before the slow probe"

    # The probe must have run on a worker thread, not the event loop thread.
    assert probe_thread_ids, "probe callable must have been invoked"
    assert all(tid != event_loop_thread_id[0] for tid in probe_thread_ids), (
        "The blocking probe must execute on a thread-pool worker thread, "
        "never on the asyncio event loop thread."
    )
