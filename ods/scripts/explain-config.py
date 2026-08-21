#!/usr/bin/env python3
"""Explain effective ODS configuration values and their provenance."""

import argparse
import json
import re
import sys
from pathlib import Path


_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_SECRET_WORDS = ("secret", "password", "pass", "token", "key", "salt", "bearer", "user", "email")


def _strip_matching_quotes(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        return value[1:-1]
    return value


def parse_env(path: Path) -> tuple[dict[str, str], dict[str, int], dict[str, list[int]], list[int]]:
    """Parse assignments without evaluating shell syntax or expansions."""
    values: dict[str, str] = {}
    lines: dict[str, int] = {}
    occurrences: dict[str, list[int]] = {}
    malformed: list[int] = []
    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            malformed.append(line_number)
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not _KEY_RE.fullmatch(key):
            malformed.append(line_number)
            continue
        occurrences.setdefault(key, []).append(line_number)
        values[key] = _strip_matching_quotes(value.strip())
        lines[key] = line_number
    duplicates = {key: value for key, value in occurrences.items() if len(value) > 1}
    return values, lines, duplicates, malformed


def _is_secret(key: str, specification: dict) -> bool:
    if specification.get("secret") is True:
        return True
    lowered = key.lower()
    return any(word in lowered for word in _SECRET_WORDS)


def build_report(
    env_file: Path,
    schema_file: Path,
    *,
    include_all: bool,
    selected_keys: list[str],
) -> dict:
    schema = json.loads(schema_file.read_text(encoding="utf-8"))
    properties = schema.get("properties")
    if not isinstance(properties, dict):
        raise ValueError("schema properties must be an object")
    required = set(schema.get("required", []))
    values, lines, duplicates, malformed = parse_env(env_file)

    if selected_keys:
        keys = set(selected_keys)
    elif include_all:
        keys = set(properties) | set(values)
    else:
        keys = set(values)
        keys.update(key for key in required if key not in values or values[key] == "")

    entries = []
    for key in sorted(keys):
        specification = properties.get(key)
        known = isinstance(specification, dict)
        specification = specification if known else {}
        secret = _is_secret(key, specification)

        if key in values:
            source = "env"
            raw_value = values[key]
            value = "***" if secret else raw_value
        elif "default" in specification:
            source = "schema_default"
            raw_value = specification["default"]
            value = "***" if secret else raw_value
        else:
            source = "unset"
            raw_value = None
            value = None

        if not known:
            status = "unknown"
        elif key in required and (source == "unset" or raw_value == ""):
            status = "missing_required"
        elif source == "env":
            status = "configured"
        elif source == "schema_default":
            status = "default"
        else:
            status = "unset"

        entries.append({
            "key": key,
            "value": value,
            "source": source,
            "status": status,
            "secret": secret,
            "required": key in required,
            "is_empty": source == "env" and raw_value == "",
            "line": lines.get(key),
            "duplicate_lines": duplicates.get(key, []),
            "type": specification.get("type"),
            "description": specification.get("description", ""),
        })

    summary = {
        "total": len(entries),
        "configured": sum(entry["status"] == "configured" for entry in entries),
        "defaults": sum(entry["status"] == "default" for entry in entries),
        "unset": sum(entry["status"] == "unset" for entry in entries),
        "missing_required": sum(entry["status"] == "missing_required" for entry in entries),
        "unknown": sum(entry["status"] == "unknown" for entry in entries),
        "duplicate_keys": len(duplicates),
        "malformed_lines": len(malformed),
    }
    return {
        "env_file": str(env_file),
        "schema_file": str(schema_file),
        "entries": entries,
        "duplicates": duplicates,
        "malformed_lines": malformed,
        "summary": summary,
    }


def _display_value(value) -> str:
    if value is None:
        return "-"
    if isinstance(value, str):
        return value or "(empty)"
    return json.dumps(value, separators=(",", ":"))


def render_table(report: dict) -> str:
    headers = ("Key", "Source", "Status", "Value")
    rows = [
        (
            entry["key"],
            entry["source"],
            entry["status"],
            _display_value(entry["value"]),
        )
        for entry in report["entries"]
    ]
    widths = [max(len(headers[index]), *(len(row[index]) for row in rows)) for index in range(4)]
    lines = [
        "  ".join(headers[index].ljust(widths[index]) for index in range(4)),
        "  ".join("-" * width for width in widths),
    ]
    lines.extend("  ".join(row[index].ljust(widths[index]) for index in range(4)) for row in rows)
    summary = report["summary"]
    lines.extend([
        "",
        (
            f"Configured: {summary['configured']}  Defaults: {summary['defaults']}  "
            f"Missing required: {summary['missing_required']}  Unknown: {summary['unknown']}  "
            f"Duplicates: {summary['duplicate_keys']}  Malformed lines: {summary['malformed_lines']}"
        ),
    ])
    return "\n".join(lines) + "\n"


def main() -> int:
    project_dir = Path(__file__).parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, default=project_dir / ".env")
    parser.add_argument("--schema", type=Path, default=project_dir / ".env.schema.json")
    parser.add_argument("--key", action="append", default=[], help="Explain one key (repeatable)")
    parser.add_argument("--all", action="store_true", help="Include unset optional schema keys")
    parser.add_argument("--format", choices=("table", "json"), default="table")
    parser.add_argument("--check", action="store_true", help="Exit 2 for missing, unknown, duplicate, or malformed input")
    args = parser.parse_args()

    try:
        report = build_report(
            args.env_file,
            args.schema,
            include_all=args.all,
            selected_keys=args.key,
        )
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    if args.format == "json":
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(render_table(report), end="")

    issue_fields = ("missing_required", "unknown", "duplicate_keys", "malformed_lines")
    if args.check and any(report["summary"][field] for field in issue_fields):
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
