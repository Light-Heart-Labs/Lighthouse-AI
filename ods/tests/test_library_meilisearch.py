from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
SERVICE_DIR = ROOT / "extensions" / "library" / "services" / "meilisearch"


def _shell_path(path: Path) -> str:
    resolved = path.resolve()
    if os.name != "nt":
        return str(resolved)
    drive = resolved.drive.rstrip(":").lower()
    return f"/mnt/{drive}/{resolved.as_posix().split(':/', 1)[1]}"


def test_meilisearch_reaches_the_dashboard_catalog_as_a_standalone_service(
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
    entry = next(item for item in catalog["extensions"] if item["id"] == "meilisearch")
    assert entry["health_endpoint"] == "/health"
    assert entry["depends_on"] == []
    assert entry["env_vars"] == [
        {
            "key": "MEILI_MASTER_KEY",
            "required": True,
            "description": "Master key for all Meilisearch API access",
        }
    ]
    assert entry["features"][0]["id"] == "meilisearch-api"


def test_meilisearch_compose_pins_and_constrains_the_public_api() -> None:
    compose = yaml.safe_load((SERVICE_DIR / "compose.yaml").read_text(encoding="utf-8"))
    service = compose["services"]["meilisearch"]

    assert service["image"] == "getmeili/meilisearch:v1.53.1"
    assert service["read_only"] is True
    assert service["cap_drop"] == ["ALL"]
    assert service["environment"]["MEILI_ENV"] == "production"
    assert service["environment"]["MEILI_NO_ANALYTICS"] == "true"
    assert service["environment"]["MEILI_MASTER_KEY"].startswith("${MEILI_MASTER_KEY:?")
    assert service["ports"] == [
        "${BIND_ADDRESS:-127.0.0.1}:${MEILISEARCH_PORT:-7700}:7700"
    ]
    assert service["volumes"] == ["./data/meilisearch:/meili_data:rw"]


def test_meilisearch_setup_is_idempotent_and_generates_a_strong_key(
    tmp_path: Path,
) -> None:
    env_file = tmp_path / ".env"
    command = ["bash", _shell_path(SERVICE_DIR / "setup.sh"), _shell_path(tmp_path)]
    subprocess.run(command, check=True)
    first = env_file.read_text(encoding="utf-8")
    subprocess.run(command, check=True)

    assert env_file.read_text(encoding="utf-8") == first
    key = first.removeprefix("MEILI_MASTER_KEY=").strip()
    assert len(key) == 64
    assert all(character in "0123456789abcdef" for character in key)
