"""Regression: the non-streaming upstream request handlers in main.py must
not swallow unrelated bugs under a bare `except Exception`.

Bug: `_handle_non_streaming()` (Anthropic) and `_handle_openai_non_streaming()`
(OpenAI) each wrapped the upstream `client.request(...)` call in
`except Exception` and the `resp.json()` parse in a second bare
`except Exception`. Per CLAUDE.md, network calls and parsing may only catch
specific exception types mapping to a distinct, meaningful status — a bare
`except Exception` also swallows real bugs (e.g. a broken client stub
raising TypeError) and reports them as an ordinary "Upstream request
failed" / "Failed to parse ... JSON", hiding the actual defect.

main.py is a FastAPI app with import-time side effects, so this test
extracts just the two target functions via regex (this repo's established
pattern for testing service-embedded logic without executing the whole
file) and execs them in an isolated namespace with minimal stubs.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

import httpx
import pytest
from fastapi.responses import JSONResponse, Response

TOKEN_SPY_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = TOKEN_SPY_DIR.parents[3]
MAIN_REL_PATH = "ods/extensions/services/token-spy/main.py"

pytestmark = pytest.mark.asyncio


def _extract_function(source: str, name: str) -> str:
    m = re.search(
        rf"^async def {re.escape(name)}\(.*?\n(?:.*\n)*?(?=^async def |^def |\Z)",
        source,
        re.MULTILINE,
    )
    assert m, f"could not extract {name}() from source"
    return m.group(0)


def _load_source(which: str) -> str:
    if which == "current":
        return (TOKEN_SPY_DIR / "main.py").read_text(encoding="utf-8")
    result = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "show", f"HEAD:{MAIN_REL_PATH}"],
        capture_output=True, text=True, check=True, encoding="utf-8",
    )
    return result.stdout


class _StubLog:
    def __init__(self):
        self.errors = []
        self.warnings = []

    def error(self, msg):
        self.errors.append(msg)

    def warning(self, msg):
        self.warnings.append(msg)


class FakeResponse:
    def __init__(self, json_data=None, json_exc=None, status_code=200,
                 content=b"{}", headers=None):
        self._json_data = json_data
        self._json_exc = json_exc
        self.status_code = status_code
        self.content = content
        self.headers = headers or {}

    def json(self):
        if self._json_exc:
            raise self._json_exc
        return self._json_data


class FakeClient:
    def __init__(self, raise_exc=None, response=None):
        self.raise_exc = raise_exc
        self.response = response

    async def request(self, method, path, content=None, headers=None):
        if self.raise_exc:
            raise self.raise_exc
        return self.response


def _build_namespace():
    return {
        "httpx": httpx,
        "json": json,
        "os": os,
        "log": _StubLog(),
        "JSONResponse": JSONResponse,
        "Response": Response,
        "_log_entry": lambda *a, **kw: None,
    }


def _load_function(which: str, name: str):
    source = _load_source(which)
    func_src = _extract_function(source, name)
    ns = _build_namespace()
    exec(compile(func_src, f"<{which}:{name}>", "exec"), ns)
    return ns[name], ns["log"]


@pytest.mark.parametrize("name,path_kw", [
    ("_handle_non_streaming", {}),
    ("_handle_openai_non_streaming", {}),
])
async def test_prefix_swallows_unrelated_bug_in_request(name, path_kw):
    """Reproduces the bug directly against the pre-fix source: a non-network
    bug raised by client.request() is silently swallowed and reported as an
    ordinary upstream failure."""
    func, log = _load_function("git", name)
    client = FakeClient(raise_exc=TypeError("not actually a network error — a real bug"))

    result = await func(client, b"{}", {}, "test-model", {}, {}, [], 0.0)

    assert isinstance(result, JSONResponse)
    assert result.status_code == 502
    assert any("Upstream request error" in e for e in log.errors), (
        "pre-fix: the real bug was misreported as an ordinary upstream request failure"
    )


@pytest.mark.parametrize("name", ["_handle_non_streaming", "_handle_openai_non_streaming"])
async def test_postfix_unrelated_bug_in_request_propagates(name):
    """The fix: a non-network bug in client.request() must crash loudly."""
    func, _log = _load_function("current", name)
    client = FakeClient(raise_exc=TypeError("not actually a network error — a real bug"))

    with pytest.raises(TypeError):
        await func(client, b"{}", {}, "test-model", {}, {}, [], 0.0)


@pytest.mark.parametrize("name", ["_handle_non_streaming", "_handle_openai_non_streaming"])
async def test_postfix_still_handles_genuine_request_errors(name):
    """No regression: a real httpx network failure must still be caught and
    reported as a 502, not crash the caller."""
    func, log = _load_function("current", name)
    client = FakeClient(raise_exc=httpx.ConnectError("connection refused"))

    result = await func(client, b"{}", {}, "test-model", {}, {}, [], 0.0)

    assert isinstance(result, JSONResponse)
    assert result.status_code == 502
    assert any("Upstream request error" in e for e in log.errors)


@pytest.mark.parametrize("name", ["_handle_non_streaming", "_handle_openai_non_streaming"])
async def test_postfix_unrelated_bug_in_json_parse_propagates(name):
    """The fix: a non-JSON bug from resp.json() must crash loudly instead of
    silently degrading token usage to zero."""
    func, _log = _load_function("current", name)
    response = FakeResponse(json_exc=AttributeError("not actually malformed JSON — a real bug"))
    client = FakeClient(response=response)

    with pytest.raises(AttributeError):
        await func(client, b"{}", {}, "test-model", {}, {}, [], 0.0)


@pytest.mark.parametrize("name", ["_handle_non_streaming", "_handle_openai_non_streaming"])
async def test_postfix_still_handles_genuine_json_decode_errors(name):
    """No regression: malformed JSON in the upstream response must still be
    caught, logging zero usage, not crash the caller."""
    func, log = _load_function("current", name)
    response = FakeResponse(json_exc=json.JSONDecodeError("bad json", "doc", 0))
    client = FakeClient(response=response)

    result = await func(client, b"{}", {}, "test-model", {}, {}, [], 0.0)

    assert isinstance(result, Response)
    assert any("Failed to parse" in w for w in log.warnings)


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
