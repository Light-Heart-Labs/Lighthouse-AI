"""Tests for the JUnit-to-GitHub-summary formatter."""

import importlib.util
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "summarize-junit.py"
SPEC = importlib.util.spec_from_file_location("summarize_junit", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def test_summary_counts_cases_and_omits_failure_payload(tmp_path):
    report = tmp_path / "junit.xml"
    report.write_text(
        """<?xml version="1.0"?>
<testsuites>
  <testsuite name="api">
    <testcase classname="tests.test_health" name="test_ok" time="0.1" />
    <testcase classname="tests.test_auth" name="test_denied" time="0.2">
      <failure message="token leaked">API_KEY=super-secret</failure>
    </testcase>
    <testcase classname="tests.test_optional" name="test_gpu" time="0.3">
      <skipped />
    </testcase>
  </testsuite>
</testsuites>
""",
        encoding="utf-8",
    )

    summary = MODULE.summarize_junit(report, "Dashboard API tests")

    assert "| 3 | 1 | 1 | 0 | 1 | 0.60s |" in summary
    assert "`tests.test_auth::test_denied` — failed (0.20s)" in summary
    assert "super-secret" not in summary
    assert "token leaked" not in summary


def test_summary_caps_failure_names_and_reports_overflow(tmp_path):
    cases = "\n".join(
        f'<testcase classname="suite" name="case_{index}" time="0"><error /></testcase>'
        for index in range(23)
    )
    report = tmp_path / "junit.xml"
    report.write_text(f"<testsuite>{cases}</testsuite>", encoding="utf-8")

    summary = MODULE.summarize_junit(report, "Tests")

    assert summary.count(" — error ") == 20
    assert "…and 3 more; see the JUnit artifact." in summary


def test_summary_escapes_multiline_and_backtick_test_names(tmp_path):
    report = tmp_path / "junit.xml"
    report.write_text(
        '<testsuite><testcase classname="api" name="bad `name&#10;line" time="1">'
        '<failure /></testcase></testsuite>',
        encoding="utf-8",
    )

    summary = MODULE.summarize_junit(report, "Tests")

    assert "`api::bad 'name line`" in summary
