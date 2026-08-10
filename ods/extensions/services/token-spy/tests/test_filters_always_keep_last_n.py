"""Regression: `always_keep_last_n` in _filter_history() must actually restore
messages that max_pairs trimming dropped, not just check-and-ignore them.

Bug: Step 7 of _filter_history() computed whether the guaranteed tail
messages were missing from the filtered output, then did nothing about it
(`pass`) when they were. A caller relying on always_keep_last_n to protect
an in-flight tool call chain from being dropped by max_pairs could silently
lose those messages, breaking the tool_call/tool_result pairing contract.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path
from uuid import uuid4

import pytest

TOKEN_SPY_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = TOKEN_SPY_DIR.parents[3]
FILTERS_REL_PATH = "ods/extensions/services/token-spy/filters.py"


def _load_from_path(path: Path, prefix: str):
    spec = importlib.util.spec_from_file_location(f"{prefix}_{uuid4().hex}", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_prefix_module(tmp_path: Path):
    """Load the pre-fix filters.py straight from git HEAD, for comparison."""
    result = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "show", f"HEAD:{FILTERS_REL_PATH}"],
        capture_output=True, text=True, check=True,
    )
    prefix_file = tmp_path / "filters_prefix.py"
    prefix_file.write_text(result.stdout, encoding="utf-8")
    return _load_from_path(prefix_file, "filters_prefix")


def _build_units(n_units: int) -> list[dict]:
    """n_units atomic [user, assistant] units, oldest first."""
    messages = []
    for i in range(n_units):
        messages.append({"role": "user", "content": f"user turn {i}"})
        messages.append({"role": "assistant", "content": f"assistant reply {i}"})
    return messages


def _run_filter_history(module, messages: list[dict], cfg: dict):
    body = {"messages": messages}
    result = module.FilterResult()
    body, result = module._filter_history(body, cfg, result, False)
    return body["messages"], result


def test_prefix_drops_guaranteed_tail_messages(tmp_path):
    """Reproduces the bug directly against the pre-fix module."""
    module = _load_prefix_module(tmp_path)
    messages = _build_units(5)  # 5 units x 2 msgs = 10 messages
    cfg = {"always_keep_last_n": 4, "max_pairs": 1}

    filtered, _result = _run_filter_history(module, messages, cfg)

    # Tail should be the last 4 raw messages (units 4 and 5), but max_pairs=1
    # only keeps unit 5 (last 2 messages) — the pre-fix no-op safety check
    # does not restore the missing unit 4 messages.
    assert len(filtered) == 2, (
        "pre-fix: expected the no-op safety check to leave only the "
        f"max_pairs-trimmed unit (2 messages), got {len(filtered)}"
    )
    filtered_contents = {m["content"] for m in filtered}
    assert "user turn 3" not in filtered_contents  # part of the dropped unit 4
    assert "assistant reply 3" not in filtered_contents


def test_postfix_restores_guaranteed_tail_messages():
    """The fix: missing tail units must be restored."""
    module = _load_from_path(TOKEN_SPY_DIR / "filters.py", "filters_current")
    messages = _build_units(5)
    cfg = {"always_keep_last_n": 4, "max_pairs": 1}

    filtered, result = _run_filter_history(module, messages, cfg)

    filtered_contents = [m["content"] for m in filtered]
    assert "user turn 3" in filtered_contents, "unit 4's user message must be restored"
    assert "assistant reply 3" in filtered_contents, "unit 4's assistant message must be restored"
    assert "user turn 4" in filtered_contents, "unit 5 (kept by max_pairs) must still be present"
    assert "assistant reply 4" in filtered_contents

    # Restored unit must come before the max_pairs-kept unit, preserving order.
    assert filtered_contents.index("user turn 3") < filtered_contents.index("user turn 4")

    # max_pairs=1 drops units 1-4 (8 messages) in Step 3; Step 7 must restore
    # unit 4 (2 messages) since it holds guaranteed tail messages, leaving
    # units 1-3 (6 messages) as the only messages legitimately dropped.
    assert result.messages_removed == 6


def test_postfix_no_restoration_needed_when_tail_already_present():
    """No-op path: max_pairs keeps enough units that the tail is already whole."""
    module = _load_from_path(TOKEN_SPY_DIR / "filters.py", "filters_current")
    messages = _build_units(5)
    cfg = {"always_keep_last_n": 4, "max_pairs": 3}  # keeps units 3,4,5 (6 msgs)

    filtered, result = _run_filter_history(module, messages, cfg)

    assert len(filtered) == 6
    assert result.messages_removed == 4  # units 1 and 2 legitimately dropped


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
