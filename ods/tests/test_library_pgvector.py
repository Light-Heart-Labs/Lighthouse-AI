from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
SERVICE_DIR = ROOT / "extensions" / "library" / "services" / "pgvector"


def _shell_path(path: Path) -> str:
    resolved = path.resolve()
    if os.name != "nt":
        return str(resolved)
    drive = resolved.drive.rstrip(":").lower()
    return f"/mnt/{drive}/{resolved.as_posix().split(':/', 1)[1]}"


def test_pgvector_reaches_catalog_with_observable_readiness(
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
    entry = next(item for item in catalog["extensions"] if item["id"] == "pgvector")
    assert entry["port"] == 5432
    assert entry["health_endpoint"] == "/metrics"
    assert entry["startup_timeout"] == 120
    assert entry["features"][0]["id"] == "pgvector-sql-search"


def test_pgvector_compose_pins_initializes_and_protects_the_database() -> None:
    compose = yaml.safe_load((SERVICE_DIR / "compose.yaml").read_text(encoding="utf-8"))
    service = compose["services"]["pgvector"]

    assert service["image"] == "pgvector/pgvector:0.8.1-pg17-trixie"
    assert service["read_only"] is True
    assert service["stop_grace_period"] == "60s"
    assert service["environment"]["POSTGRES_PASSWORD"].startswith(
        "${PGVECTOR_PASSWORD:?"
    )
    assert "--data-checksums" in service["environment"]["POSTGRES_INITDB_ARGS"]
    assert service["ports"] == [
        "${BIND_ADDRESS:-127.0.0.1}:${PGVECTOR_PORT:-5432}:5432",
        "${BIND_ADDRESS:-127.0.0.1}:9187:9187",
    ]
    assert (
        "./config/pgvector/init-vector.sql:"
        "/docker-entrypoint-initdb.d/10-vector.sql:ro"
    ) in service["volumes"]
    assert "pg_isready" in service["healthcheck"]["test"][-1]

    metrics = compose["services"]["pgvector-metrics"]
    assert metrics["image"] == (
        "quay.io/prometheuscommunity/postgres-exporter:v0.20.1"
    )
    assert metrics["network_mode"] == "service:pgvector"
    assert metrics["read_only"] is True
    assert metrics["cap_drop"] == ["ALL"]
    assert "pg_up 1" in metrics["healthcheck"]["test"][-1]


def test_pgvector_initialization_contract_activates_the_vector_extension() -> None:
    init_sql = (
        SERVICE_DIR / "config" / "pgvector" / "init-vector.sql"
    ).read_text(encoding="utf-8")
    assert init_sql.strip() == "CREATE EXTENSION IF NOT EXISTS vector;"


def test_pgvector_setup_is_idempotent_and_generates_a_strong_password(
    tmp_path: Path,
) -> None:
    env_file = tmp_path / ".env"
    command = ["bash", _shell_path(SERVICE_DIR / "setup.sh"), _shell_path(tmp_path)]
    subprocess.run(command, check=True)
    first = env_file.read_text(encoding="utf-8")
    subprocess.run(command, check=True)

    assert env_file.read_text(encoding="utf-8") == first
    password = first.removeprefix("PGVECTOR_PASSWORD=").strip()
    assert len(password) == 64
    assert all(character in "0123456789abcdef" for character in password)
