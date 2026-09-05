from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
SERVICE_DIR = ROOT / "extensions" / "library" / "services" / "docling-serve"


def test_docling_serve_reaches_the_generated_dashboard_catalog(tmp_path: Path) -> None:
    output = tmp_path / "catalog.json"
    subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "generate-extensions-catalog.py"),
            "--library-dir",
            str(ROOT / "extensions" / "library" / "services"),
            "--output",
            str(output),
        ],
        check=True,
    )

    catalog = json.loads(output.read_text(encoding="utf-8"))
    entry = next(item for item in catalog["extensions"] if item["id"] == "docling-serve")
    assert entry["health_endpoint"] == "/readyz"
    assert entry["external_port_default"] == 5001
    assert entry["features"][0]["launch"]["path"] == "/ui"


def test_docling_serve_compose_keeps_the_public_boundary_reproducible() -> None:
    compose = yaml.safe_load((SERVICE_DIR / "compose.yaml").read_text(encoding="utf-8"))
    service = compose["services"]["docling-serve"]

    assert service["image"] == "quay.io/docling-project/docling-serve-cpu:v1.30.0"
    assert service["ports"] == [
        "${BIND_ADDRESS:-127.0.0.1}:${DOCLING_SERVE_PORT:-5001}:5001"
    ]
    assert "/readyz" in " ".join(service["healthcheck"]["test"])
