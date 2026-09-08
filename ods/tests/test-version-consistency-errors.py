#!/usr/bin/env python3
"""Unit tests for check-version-consistency.py error reporting.

Regression: version authorities that live above the ods/ directory (notably
ARCHITECTURE.md at the repository root) made first_match() raise a
Path.relative_to() ValueError while building its own "could not find version"
message. The gate then reported an opaque "is not in the subpath of" string
that named neither the failing check nor the real problem.
"""

from __future__ import annotations

import importlib.util
import sys
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


def test_display_path_inside_root_is_repo_relative() -> None:
    module = load_module()
    assert module.display_path(module.ROOT / "ods-cli") == "ods-cli"
    assert module.display_path(
        module.ROOT / "installers" / "lib" / "constants.sh"
    ) == str(Path("installers/lib/constants.sh"))


def test_display_path_above_root_does_not_raise() -> None:
    """ARCHITECTURE.md sits one level above ROOT; relative_to(ROOT) fails there."""
    module = load_module()
    assert module.display_path(module.ROOT.parent / "ARCHITECTURE.md") == "ARCHITECTURE.md"


def test_display_path_falls_back_to_absolute_for_unrelated_paths() -> None:
    module = load_module()
    unrelated = Path("/tmp/somewhere-else/VERSION.md")
    assert module.display_path(unrelated) == str(unrelated)


def test_missing_version_above_root_reports_the_real_problem() -> None:
    """A non-matching pattern on ARCHITECTURE.md must name the check and the file."""
    module = load_module()
    checks: list[tuple[str, str]] = []
    errors: list[str] = []

    module.add_regex_check(
        checks,
        errors,
        "ARCHITECTURE.md version",
        module.ROOT.parent / "ARCHITECTURE.md",
        r"^> Version NO-SUCH-MARKER-([0-9.]+)\s+\|",
    )

    assert checks == []
    assert len(errors) == 1, errors
    assert errors[0] == "ARCHITECTURE.md version: could not find version in ARCHITECTURE.md"
    assert "subpath" not in errors[0]


def test_missing_version_inside_root_still_reports_cleanly() -> None:
    module = load_module()
    checks: list[tuple[str, str]] = []
    errors: list[str] = []

    module.add_regex_check(
        checks,
        errors,
        "ods-cli VERSION",
        module.ROOT / "ods-cli",
        r'^NO_SUCH_VERSION_KEY="([^"]+)"',
    )

    assert checks == []
    assert errors == ["ods-cli VERSION: could not find version in ods-cli"]


def test_repo_versions_are_consistent() -> None:
    """The real gate still passes on the checked-in tree."""
    module = load_module()
    assert module.main() == 0


def main() -> int:
    tests = [
        test_display_path_inside_root_is_repo_relative,
        test_display_path_above_root_does_not_raise,
        test_display_path_falls_back_to_absolute_for_unrelated_paths,
        test_missing_version_above_root_reports_the_real_problem,
        test_missing_version_inside_root_still_reports_cleanly,
        test_repo_versions_are_consistent,
    ]
    for test in tests:
        test()
    print("[PASS] version consistency error-reporting tests")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
