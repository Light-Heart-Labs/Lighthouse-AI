"""Public-boundary tests for scripts/generate-runtime-sbom.py."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "generate-runtime-sbom.py"


def _generate() -> tuple[bytes, dict]:
    result = subprocess.run(
        [sys.executable, str(SCRIPT)],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    return result.stdout, json.loads(result.stdout)


def test_cli_emits_deterministic_cyclonedx_inventory():
    first_bytes, first = _generate()
    second_bytes, second = _generate()

    assert first_bytes == second_bytes
    assert first == second
    assert first["bomFormat"] == "CycloneDX"
    assert first["specVersion"] == "1.5"
    assert first["metadata"]["component"]["name"] == "ODS"
    assert first["components"]


def test_every_source_image_is_represented_once():
    _, bom = _generate()
    references = [
        next(
            prop["value"]
            for prop in component["properties"]
            if prop["name"] == "ods:image-reference"
        )
        for component in bom["components"]
    ]

    assert references == sorted(set(references))
    assert any("extension-library" in prop["value"]
               for component in bom["components"]
               for prop in component["properties"]
               if prop["name"] == "ods:scopes")
    root_dependency = bom["dependencies"][0]
    assert root_dependency["dependsOn"] == [
        component["bom-ref"] for component in bom["components"]
    ]


def test_output_path_is_parseable_and_matches_stdout(tmp_path):
    expected_bytes, expected = _generate()
    output = tmp_path / "artifacts" / "ods-runtime.cdx.json"

    subprocess.run(
        [sys.executable, str(SCRIPT), "--output", str(output)],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )

    assert output.read_bytes() == expected_bytes
    assert json.loads(output.read_text(encoding="utf-8")) == expected
