#!/usr/bin/env python3
"""Render a compact, secret-safe Markdown summary from a JUnit XML report."""

import argparse
import xml.etree.ElementTree as ET
from pathlib import Path


def _test_name(case: ET.Element) -> str:
    class_name = case.get("classname", "").strip()
    name = case.get("name", "unnamed test").strip()
    value = f"{class_name}::{name}" if class_name else name
    return value.replace("`", "'").replace("\n", " ")


def summarize_junit(report: Path, title: str) -> str:
    """Return a Markdown summary without embedding failure output or logs."""
    root = ET.parse(report).getroot()
    cases = root.findall(".//testcase")
    if root.tag == "testcase":
        cases = [root]

    failed = [case for case in cases if case.find("failure") is not None]
    errors = [case for case in cases if case.find("error") is not None]
    skipped = [case for case in cases if case.find("skipped") is not None]
    unsuccessful = {id(case) for case in failed + errors + skipped}
    passed = sum(1 for case in cases if id(case) not in unsuccessful)
    duration = sum(float(case.get("time", "0")) for case in cases)

    lines = [
        f"## {title}",
        "",
        "| Total | Passed | Failed | Errors | Skipped | Duration |",
        "| ---: | ---: | ---: | ---: | ---: | ---: |",
        (
            f"| {len(cases)} | {passed} | {len(failed)} | {len(errors)} | "
            f"{len(skipped)} | {duration:.2f}s |"
        ),
    ]

    problem_cases = [(case, "failed") for case in failed]
    problem_cases.extend((case, "error") for case in errors)
    if problem_cases:
        lines.extend(["", "### Unsuccessful tests", ""])
        for case, outcome in problem_cases[:20]:
            case_duration = float(case.get("time", "0"))
            lines.append(f"- `{_test_name(case)}` — {outcome} ({case_duration:.2f}s)")
        if len(problem_cases) > 20:
            lines.append(f"- …and {len(problem_cases) - 20} more; see the JUnit artifact.")

    lines.extend([
        "",
        "Failure messages and captured output are intentionally omitted; use the CI log or JUnit artifact.",
    ])
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path, help="JUnit XML report")
    parser.add_argument("--title", default="Test results", help="Markdown heading")
    args = parser.parse_args()
    print(summarize_junit(args.report, args.title), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
