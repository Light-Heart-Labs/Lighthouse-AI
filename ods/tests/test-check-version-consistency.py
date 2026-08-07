#!/usr/bin/env python3
"""Unit tests for version authority parsing."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from tempfile import TemporaryDirectory


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "check-version-consistency.py"


def load_module():
    spec = importlib.util.spec_from_file_location("check_version_consistency", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _parse(contents: str):
    module = load_module()
    with TemporaryDirectory() as tmp:
        module.ROOT = Path(tmp)
        (module.ROOT / ".version").write_text(contents, encoding="utf-8")
        return module.optional_version_file()


def test_plain_version_is_supported() -> None:
    assert _parse("3.4.0\n") == "3.4.0"


def test_json_string_version_is_unwrapped() -> None:
    assert _parse('"3.4.0"\n') == "3.4.0"


def test_json_object_version_is_unwrapped() -> None:
    assert _parse('{"version": "3.4.0"}\n') == "3.4.0"


def test_json_object_requires_string_version() -> None:
    try:
        _parse('{"version": 340}\n')
    except ValueError as exc:
        assert "non-empty string version" in str(exc)
    else:
        raise AssertionError("numeric JSON version must be rejected")


if __name__ == "__main__":
    test_plain_version_is_supported()
    test_json_string_version_is_unwrapped()
    test_json_object_version_is_unwrapped()
    test_json_object_requires_string_version()
    print("[PASS] version consistency tests")
