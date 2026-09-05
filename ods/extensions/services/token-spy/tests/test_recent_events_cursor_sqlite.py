"""Regression: SQLite query_recent_events() must not re-emit already-sent
events to the SSE stream.

Bug: the cursor query ordered results `ORDER BY timestamp DESC` (newest
first) while the SSE loop in main.py advances its cursor to the `id` of the
LAST event in each returned batch (`for event in events: ... last_cursor =
event.get("id")`). With a DESC-ordered batch, "last processed" lands on the
OLDEST id in that batch, not the newest — so the next poll re-fetches
everything newer than that stale cursor, re-sending events the client
already received.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
import tempfile
from pathlib import Path
from uuid import uuid4

import pytest

TOKEN_SPY_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = TOKEN_SPY_DIR.parents[3]
DB_REL_PATH = "ods/extensions/services/token-spy/db.py"


def _load_from_path(path: Path, prefix: str, db_path: Path):
    import os
    os.environ["DB_PATH"] = str(db_path)
    spec = importlib.util.spec_from_file_location(f"{prefix}_{uuid4().hex}", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    del os.environ["DB_PATH"]
    return module


def _load_prefix_module(tmp_path: Path, db_path: Path):
    """Load the pre-fix db.py straight from git HEAD, for comparison."""
    result = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "show", f"HEAD:{DB_REL_PATH}"],
        capture_output=True, text=True, check=True,
    )
    prefix_file = tmp_path / "db_prefix.py"
    prefix_file.write_text(result.stdout, encoding="utf-8")
    return _load_from_path(prefix_file, "db_prefix", db_path)


def _seed_events(module, count: int):
    module.init_db()
    for i in range(count):
        module.log_usage({
            "agent": "test-agent",
            "model": "test-model",
            "input_tokens": 10 + i,
            "output_tokens": 5 + i,
        })


def _simulate_sse_stream(module, poll_limit: int, max_polls: int = 10):
    """Mirrors main.py's token_events() loop exactly: advance the cursor to
    the id (or _cursor, for postgres) of the LAST event in each batch."""
    last_cursor = None
    seen_ids = []
    for _ in range(max_polls):
        events = module.query_recent_events(limit=poll_limit, after_id=last_cursor)
        if not events:
            break
        for event in events:
            seen_ids.append(event["id"])
            last_cursor = event.get("_cursor", event.get("id"))
    return seen_ids


def test_prefix_reemits_events_to_sse_stream(tmp_path):
    """Reproduces the bug directly against the pre-fix module."""
    db_path = tmp_path / "prefix.db"
    module = _load_prefix_module(tmp_path, db_path)
    _seed_events(module, 5)

    seen_ids = _simulate_sse_stream(module, poll_limit=2)

    assert len(seen_ids) != len(set(seen_ids)), (
        f"pre-fix: expected a duplicate id from the stale DESC-ordered "
        f"cursor, got no duplicates in {seen_ids}"
    )


def test_postfix_no_reemitted_events(tmp_path):
    """The fix: every event must be emitted exactly once, oldest first.

    Backlog fits entirely within the initial poll window (poll_limit=5,
    5 events) — this isolates the "no duplicates, no gaps" property from
    the separate, intentional "initial poll only shows the recent window"
    behavior exercised below.
    """
    db_path = tmp_path / "postfix.db"
    module = _load_from_path(TOKEN_SPY_DIR / "db.py", "db_current", db_path)
    _seed_events(module, 5)

    seen_ids = _simulate_sse_stream(module, poll_limit=5)

    assert len(seen_ids) == len(set(seen_ids)), f"post-fix: got duplicates in {seen_ids}"
    assert seen_ids == sorted(seen_ids), f"post-fix: expected chronological order, got {seen_ids}"
    assert len(seen_ids) == 5


def test_postfix_catches_up_new_arrivals_without_gaps_or_dupes(tmp_path):
    """Once a cursor exists, events that arrive *after* the initial poll —
    even a backlog bigger than one poll's limit — must all be delivered
    across subsequent polls, in order, with no gaps or repeats.

    (The initial cursor-less poll only returning the most recent window is
    separate, intentional "live tail" behavior — matched from
    db_postgres.py — not a gap in the streamed history.)
    """
    db_path = tmp_path / "catchup.db"
    module = _load_from_path(TOKEN_SPY_DIR / "db.py", "db_current", db_path)
    _seed_events(module, 2)

    last_cursor = None
    seen_ids = []
    initial = module.query_recent_events(limit=2, after_id=last_cursor)
    for event in initial:
        seen_ids.append(event["id"])
        last_cursor = event.get("_cursor", event.get("id"))

    _seed_events(module, 7)  # backlog arrives after the stream already started

    for _ in range(20):
        events = module.query_recent_events(limit=2, after_id=last_cursor)
        if not events:
            break
        for event in events:
            seen_ids.append(event["id"])
            last_cursor = event.get("_cursor", event.get("id"))

    assert seen_ids == sorted(seen_ids), f"expected chronological order, got {seen_ids}"
    assert len(seen_ids) == len(set(seen_ids)), f"got duplicates in {seen_ids}"
    assert len(seen_ids) == 9


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
