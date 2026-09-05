from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
SERVICE_DIR = ROOT / "extensions" / "library" / "services" / "apache-tika"


def test_apache_tika_reaches_the_generated_dashboard_catalog(tmp_path: Path) -> None:
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
    entry = next(item for item in catalog["extensions"] if item["id"] == "apache-tika")
    assert entry["health_endpoint"] == "/tika"
    assert entry["external_port_default"] == 9998
    assert entry["features"][0]["launch"]["service"] == "apache-tika"


def test_apache_tika_compose_is_pinned_and_loopback_safe() -> None:
    compose = yaml.safe_load((SERVICE_DIR / "compose.yaml").read_text(encoding="utf-8"))
    service = compose["services"]["apache-tika"]

    assert service["image"] == "apache/tika:3.2.3.0-full"
    assert service["ports"] == [
        "${BIND_ADDRESS:-127.0.0.1}:${APACHE_TIKA_PORT:-9998}:9998"
    ]
    assert service["cap_drop"] == ["ALL"]
    assert "/tika" in " ".join(service["healthcheck"]["test"])
