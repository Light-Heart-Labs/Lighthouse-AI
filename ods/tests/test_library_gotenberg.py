from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
SERVICE_DIR = ROOT / "extensions" / "library" / "services" / "gotenberg"


def test_gotenberg_reaches_the_generated_dashboard_catalog(tmp_path: Path) -> None:
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
    entry = next(item for item in catalog["extensions"] if item["id"] == "gotenberg")
    assert entry["health_endpoint"] == "/health"
    assert entry["external_port_default"] == 3000
    assert entry["features"][0]["launch"] == {"type": "none"}


def test_gotenberg_compose_pins_runtime_and_blocks_private_sources() -> None:
    compose = yaml.safe_load((SERVICE_DIR / "compose.yaml").read_text(encoding="utf-8"))
    service = compose["services"]["gotenberg"]

    assert service["image"] == "gotenberg/gotenberg:8.36.0"
    assert service["ports"] == [
        "${BIND_ADDRESS:-127.0.0.1}:${GOTENBERG_PORT:-3000}:3000"
    ]
    assert service["cap_drop"] == ["ALL"]
    assert "--api-download-from-deny-private-ips=${GOTENBERG_DENY_PRIVATE_IPS:-true}" in service["command"]
    assert "/health" in " ".join(service["healthcheck"]["test"])
