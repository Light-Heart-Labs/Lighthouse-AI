from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
SERVICE_DIR = ROOT / "extensions" / "library" / "services" / "typesense"


def _shell_path(path: Path) -> str:
    resolved = path.resolve()
    if os.name != "nt":
        return str(resolved)
    drive = resolved.drive.rstrip(":").lower()
    return f"/mnt/{drive}/{resolved.as_posix().split(':/', 1)[1]}"


def test_typesense_reaches_the_dashboard_catalog_with_health_and_key_contract(
    tmp_path: Path,
) -> None:
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
    entry = next(item for item in catalog["extensions"] if item["id"] == "typesense")
    assert entry["health_endpoint"] == "/health"
    assert entry["env_vars"][0]["key"] == "TYPESENSE_API_KEY"
    assert entry["env_vars"][0]["required"] is True
    assert entry["features"][0]["id"] == "typesense-search-api"


def test_typesense_compose_pins_and_constrains_the_search_boundary() -> None:
    compose = yaml.safe_load((SERVICE_DIR / "compose.yaml").read_text(encoding="utf-8"))
    service = compose["services"]["typesense"]

    assert service["image"] == "typesense/typesense:30.2"
    assert service["read_only"] is True
    assert service["cap_drop"] == ["ALL"]
    assert service["environment"]["TYPESENSE_DATA_DIR"] == "/data"
    assert service["environment"]["TYPESENSE_ENABLE_CORS"] == "false"
    assert service["environment"]["TYPESENSE_DISK_USED_MAX_PERCENTAGE"] == "90"
    assert service["environment"]["TYPESENSE_MEMORY_USED_MAX_PERCENTAGE"] == "90"
    assert service["ports"] == [
        "${BIND_ADDRESS:-127.0.0.1}:${TYPESENSE_PORT:-8108}:8108"
    ]
    health_command = service["healthcheck"]["test"][-1]
    assert "GET /health HTTP/1.1" in health_command


def test_typesense_setup_is_idempotent_and_generates_a_strong_key(
    tmp_path: Path,
) -> None:
    env_file = tmp_path / ".env"
    command = ["bash", _shell_path(SERVICE_DIR / "setup.sh"), _shell_path(tmp_path)]
    subprocess.run(command, check=True)
    first = env_file.read_text(encoding="utf-8")
    subprocess.run(command, check=True)

    assert env_file.read_text(encoding="utf-8") == first
    key = first.removeprefix("TYPESENSE_API_KEY=").strip()
    assert len(key) == 64
    assert all(character in "0123456789abcdef" for character in key)
