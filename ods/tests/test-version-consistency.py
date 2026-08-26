#!/usr/bin/env python3
"""Unit tests for scripts/check-version-consistency.py."""

from __future__ import annotations

import importlib.util
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "check-version-consistency.py"


def load_module():
    spec = importlib.util.spec_from_file_location("check_version_consistency", SCRIPT)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


@contextmanager
def fake_root(module, root: Path):
    """Temporarily point module.ROOT at a sandbox so ValueError messages
    (which call path.relative_to(ROOT)) resolve against paths under it."""
    original = module.ROOT
    module.ROOT = root
    try:
        yield
    finally:
        module.ROOT = original


def test_repo_version_consistency_passes() -> None:
    module = load_module()
    assert module.main() == 0


def test_first_match_returns_captured_group() -> None:
    module = load_module()
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        with fake_root(module, root):
            target = root / "constants.sh"
            target.write_text('VERSION="1.2.3"\n', encoding="utf-8")
            value = module.first_match(target, r'^VERSION="([^"]+)"', "test label")
            assert value == "1.2.3"


def test_first_match_raises_when_pattern_missing() -> None:
    module = load_module()
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        with fake_root(module, root):
            target = root / "constants.sh"
            target.write_text("# no version here\n", encoding="utf-8")
            try:
                module.first_match(target, r'^VERSION="([^"]+)"', "missing label")
            except ValueError as exc:
                assert "missing label" in str(exc)
            else:
                raise AssertionError("first_match should raise ValueError when pattern is absent")


def test_add_regex_check_appends_error_on_failure() -> None:
    module = load_module()
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        with fake_root(module, root):
            target = root / "no-match.sh"
            target.write_text("# no version pattern in this file\n", encoding="utf-8")
            checks: list[tuple[str, str]] = []
            errors: list[str] = []
            module.add_regex_check(checks, errors, "bad label", target, r'^VERSION="([^"]+)"')
            assert checks == []
            assert len(errors) == 1
            assert "bad label" in errors[0]


def test_add_regex_check_appends_check_on_success() -> None:
    module = load_module()
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        with fake_root(module, root):
            target = root / "constants.sh"
            target.write_text('VERSION="9.9.9"\n', encoding="utf-8")
            checks: list[tuple[str, str]] = []
            errors: list[str] = []
            module.add_regex_check(checks, errors, "good label", target, r'^VERSION="([^"]+)"')
            assert errors == []
            assert checks == [("good label", "9.9.9")]


def test_optional_version_file_missing_returns_none() -> None:
    module = load_module()
    with tempfile.TemporaryDirectory() as tmp:
        with fake_root(module, Path(tmp)):
            assert module.optional_version_file() is None


def test_optional_version_file_reads_json_dict() -> None:
    module = load_module()
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        with fake_root(module, root):
            (root / ".version").write_text('{"version": "2.0.0"}\n', encoding="utf-8")
            assert module.optional_version_file() == "2.0.0"


def test_optional_version_file_falls_back_to_raw_text() -> None:
    module = load_module()
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        with fake_root(module, root):
            (root / ".version").write_text("3.0.0\n", encoding="utf-8")
            assert module.optional_version_file() == "3.0.0"


def main() -> int:
    tests = [
        test_repo_version_consistency_passes,
        test_first_match_returns_captured_group,
        test_first_match_raises_when_pattern_missing,
        test_add_regex_check_appends_error_on_failure,
        test_add_regex_check_appends_check_on_success,
        test_optional_version_file_missing_returns_none,
        test_optional_version_file_reads_json_dict,
        test_optional_version_file_falls_back_to_raw_text,
    ]
    for test in tests:
        test()
    print("[PASS] version consistency tests")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
