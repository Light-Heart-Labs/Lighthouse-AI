from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
SERVICE_DIR = ROOT / "extensions" / "library" / "services" / "falkordb"


def _shell_path(path: Path) -> str:
    resolved = path.resolve()
    if os.name != "nt":
        return str(resolved)
    drive = resolved.drive.rstrip(":").lower()
    return f"/mnt/{drive}/{resolved.as_posix().split(':/', 1)[1]}"


def test_falkordb_reaches_catalog_with_a_graph_explorer(tmp_path: Path) -> None:
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
    entry = next(item for item in catalog["extensions"] if item["id"] == "falkordb")
    assert entry["health_endpoint"] == "/"
    assert entry["startup_timeout"] == 180
    assert entry["features"][0]["id"] == "falkordb-knowledge-graph"
    assert entry["features"][0]["launch"]["path"] == "/"


def test_falkordb_compose_protects_graph_data_and_browser_credentials() -> None:
    compose = yaml.safe_load((SERVICE_DIR / "compose.yaml").read_text(encoding="utf-8"))
    service = compose["services"]["falkordb"]

    assert service["image"] == "falkordb/falkordb:v4.20.3"
    assert service["user"] == "redis"
    assert service["read_only"] is True
    assert service["cap_drop"] == ["ALL"]
    assert service["environment"]["BROWSER"] == "1"
    assert service["environment"]["FALKORDB_PASSWORD"].startswith(
        "${FALKORDB_PASSWORD:?"
    )
    assert service["environment"]["AUTH_SECRET"].startswith(
        "${FALKORDB_AUTH_SECRET:?"
    )
    assert service["environment"]["ENCRYPTION_KEY"].startswith(
        "${FALKORDB_ENCRYPTION_KEY:?"
    )
    redis_args = service["environment"]["REDIS_ARGS"]
    assert "--appendonly yes" in redis_args
    assert "--maxmemory-policy noeviction" in redis_args
    assert service["ports"] == [
        "${BIND_ADDRESS:-127.0.0.1}:${FALKORDB_PORT:-6379}:6379",
        "${BIND_ADDRESS:-127.0.0.1}:${FALKORDB_UI_PORT:-3000}:3000",
    ]
    health = service["healthcheck"]["test"][-1]
    assert "redis-cli ping" in health
    assert "http://127.0.0.1:3000/" in health


def test_falkordb_setup_is_idempotent_and_generates_distinct_secrets(
    tmp_path: Path,
) -> None:
    env_file = tmp_path / ".env"
    command = ["bash", _shell_path(SERVICE_DIR / "setup.sh"), _shell_path(tmp_path)]
    subprocess.run(command, check=True)
    first = env_file.read_text(encoding="utf-8")
    subprocess.run(command, check=True)

    assert env_file.read_text(encoding="utf-8") == first
    values = dict(line.split("=", 1) for line in first.splitlines())
    assert set(values) == {
        "FALKORDB_PASSWORD",
        "FALKORDB_AUTH_SECRET",
        "FALKORDB_ENCRYPTION_KEY",
    }
    assert all(len(value) == 64 for value in values.values())
    assert len(set(values.values())) == 3
