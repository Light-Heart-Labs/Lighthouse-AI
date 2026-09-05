"""Regression: the local session-status helpers in main.py must not swallow
unrelated bugs under a bare `except Exception`.

Bug: `_get_local_session_status()` and `_get_local_accumulated_turns()` each
wrapped a file-read in `except Exception: log.warning(...)`. Per this repo's
CLAUDE.md, file I/O may only catch specific exception types that map to a
distinct, meaningful status (e.g. OSError, UnicodeDecodeError) — a bare
`except Exception` also swallows real bugs (e.g. a TypeError from a caller
passing the wrong type) and reports them as an ordinary "failed to read
session file", hiding the actual defect.

These functions live in main.py, a FastAPI app with heavy import-time side
effects, so this test extracts just the two function bodies via regex
(matching this repo's established pattern for testing CLI-embedded logic
without executing the whole file) and execs them in an isolated namespace
with minimal stubs.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

TOKEN_SPY_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = TOKEN_SPY_DIR.parents[3]
MAIN_REL_PATH = "ods/extensions/services/token-spy/main.py"

FUNC_NAMES = ["_get_local_session_status", "_get_local_accumulated_turns"]


def _extract_functions(source: str, names: list[str]) -> str:
    chunks = []
    for name in names:
        m = re.search(
            rf"^def {re.escape(name)}\(.*?\n(?:.*\n)*?(?=^def |\Z)",
            source,
            re.MULTILINE,
        )
        assert m, f"could not extract {name}() from source"
        chunks.append(m.group(0))
    return "\n\n".join(chunks)


class _StubLog:
    def __init__(self):
        self.warnings = []

    def warning(self, msg):
        self.warnings.append(msg)


def _build_namespace(sessions_dir: Path, extra_agent_dirs=None):
    agent_dirs = {"test-agent": str(sessions_dir)}
    if extra_agent_dirs:
        agent_dirs.update(extra_agent_dirs)
    ns = {
        "os": os,
        "json": json,
        "log": _StubLog(),
        "AGENT_SESSION_DIRS": agent_dirs,
        "LOCAL_MODEL_AGENTS": set(),
        "AUTO_RESET_HISTORY_CHARS": 100_000,
        "get_agent_setting": lambda agent, key: None,
    }
    return ns


def _load_source(rel_or_git: str, tmp_path: Path = None) -> str:
    if rel_or_git == "current":
        return (TOKEN_SPY_DIR / "main.py").read_text(encoding="utf-8")
    result = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "show", f"HEAD:{MAIN_REL_PATH}"],
        capture_output=True, text=True, check=True, encoding="utf-8",
    )
    return result.stdout


def test_prefix_swallows_unrelated_bug_as_a_file_read_failure(tmp_path):
    """Reproduces the bug directly against the pre-fix source."""
    source = _load_source("git")
    func_src = _extract_functions(source, ["_get_local_session_status"])

    sessions_dir = tmp_path / "sessions"
    sessions_dir.mkdir()
    (sessions_dir / "a.jsonl").write_text('{"type":"message","message":{"role":"user","content":"hi"}}\n')

    ns = _build_namespace(sessions_dir)
    exec(compile(func_src, "<prefix>", "exec"), ns)

    real_open = open

    def boom_open(path, *a, **kw):
        if str(path).endswith("a.jsonl"):
            raise TypeError("not actually a file I/O error — a real bug")
        return real_open(path, *a, **kw)

    ns["open"] = boom_open
    result = ns["_get_local_session_status"]("test-agent")

    assert result is None, "pre-fix: bare except swallowed the TypeError and returned None"
    assert any("Failed to read session file" in w for w in ns["log"].warnings), (
        "pre-fix: the real bug was misreported as an ordinary file-read failure"
    )


def test_postfix_unrelated_bug_propagates_instead_of_being_swallowed(tmp_path):
    """The fix: a non-OSError bug must crash loudly, not get logged as a
    routine file-read failure."""
    source = _load_source("current")
    func_src = _extract_functions(source, ["_get_local_session_status"])

    sessions_dir = tmp_path / "sessions"
    sessions_dir.mkdir()
    (sessions_dir / "a.jsonl").write_text('{"type":"message","message":{"role":"user","content":"hi"}}\n')

    ns = _build_namespace(sessions_dir)
    exec(compile(func_src, "<postfix>", "exec"), ns)

    real_open = open

    def boom_open(path, *a, **kw):
        if str(path).endswith("a.jsonl"):
            raise TypeError("not actually a file I/O error — a real bug")
        return real_open(path, *a, **kw)

    ns["open"] = boom_open

    with pytest.raises(TypeError):
        ns["_get_local_session_status"]("test-agent")


def test_postfix_still_handles_genuine_os_errors_gracefully(tmp_path):
    """No regression: a real I/O failure (permission/missing file) must
    still be caught and reported as before, not crash the caller."""
    source = _load_source("current")
    func_src = _extract_functions(source, ["_get_local_session_status"])

    sessions_dir = tmp_path / "sessions"
    sessions_dir.mkdir()
    (sessions_dir / "a.jsonl").write_text('{"type":"message","message":{"role":"user","content":"hi"}}\n')

    ns = _build_namespace(sessions_dir)
    exec(compile(func_src, "<postfix2>", "exec"), ns)

    real_open = open

    def missing_open(path, *a, **kw):
        if str(path).endswith("a.jsonl"):
            raise FileNotFoundError(f"deleted between glob and open: {path}")
        return real_open(path, *a, **kw)

    ns["open"] = missing_open
    result = ns["_get_local_session_status"]("test-agent")

    assert result is None
    assert any("Failed to read session file" in w for w in ns["log"].warnings)


def test_postfix_accumulated_turns_still_handles_os_errors(tmp_path):
    """Same narrowing applies to _get_local_accumulated_turns(); a real I/O
    failure on one session file must be logged and skipped, not crash the
    whole accumulation loop."""
    source = _load_source("current")
    func_src = _extract_functions(source, ["_get_local_accumulated_turns"])

    sessions_dir = tmp_path / "sessions"
    sessions_dir.mkdir()
    (sessions_dir / "a.jsonl").write_text('{"type":"message","message":{"role":"user","content":"hi"}}\n')
    (sessions_dir / "b.jsonl").write_text('{"type":"message","message":{"role":"user","content":"hi"}}\n')

    ns = _build_namespace(sessions_dir)
    # _get_local_accumulated_turns() derives its accumulator file path from
    # __file__ — point it at a throwaway location so the test doesn't write
    # into the real extensions/services/token-spy/data/ directory.
    ns["__file__"] = str(tmp_path / "fake_main.py")
    exec(compile(func_src, "<postfix3>", "exec"), ns)

    real_open = open

    def flaky_open(path, *a, **kw):
        if str(path).endswith("a.jsonl"):
            raise PermissionError("simulated permission failure")
        return real_open(path, *a, **kw)

    ns["open"] = flaky_open
    total = ns["_get_local_accumulated_turns"]("test-agent")

    assert isinstance(total, int)
    assert any("Failed to read session file" in w for w in ns["log"].warnings)


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
