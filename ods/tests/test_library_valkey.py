from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
SERVICE_DIR = ROOT / "extensions" / "library" / "services" / "valkey"


def _shell_path(path: Path) -> str:
    resolved = path.resolve()
    if os.name != "nt":
        return str(resolved)
    drive = resolved.drive.rstrip(":").lower()
    return f"/mnt/{drive}/{resolved.as_posix().split(':/', 1)[1]}"


def test_valkey_reaches_catalog_with_durable_state_and_metrics(tmp_path: Path) -> None:
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
    entry = next(item for item in catalog["extensions"] if item["id"] == "valkey")
    assert entry["port"] == 6379
    assert entry["health_endpoint"] == "/metrics"
    assert entry["env_vars"][0]["key"] == "VALKEY_PASSWORD"
    assert entry["features"][0]["id"] == "valkey-agent-state"


def test_valkey_compose_locks_auth_durability_and_no_eviction() -> None:
    compose = yaml.safe_load((SERVICE_DIR / "compose.yaml").read_text(encoding="utf-8"))
    service = compose["services"]["valkey"]

    assert service["image"] == "valkey/valkey:9.1.1-alpine"
    assert service["user"] == "valkey"
    assert service["read_only"] is True
    assert service["cap_drop"] == ["ALL"]
    assert service["environment"]["VALKEYCLI_AUTH"].startswith("${VALKEY_PASSWORD:?")
    assert service["ports"] == [
        "${BIND_ADDRESS:-127.0.0.1}:${VALKEY_PORT:-6379}:6379",
        "${BIND_ADDRESS:-127.0.0.1}:9121:9121",
    ]
    command = service["command"]
    assert command[command.index("--appendonly") + 1] == "yes"
    assert command[command.index("--appendfsync") + 1] == "everysec"
    assert command[command.index("--maxmemory-policy") + 1] == "noeviction"

    metrics = compose["services"]["valkey-metrics"]
    assert metrics["image"] == "oliver006/redis_exporter:v1.89.0-alpine"
    assert metrics["network_mode"] == "service:valkey"
    assert metrics["read_only"] is True
    assert metrics["cap_drop"] == ["ALL"]
    assert "redis_up 1" in metrics["healthcheck"]["test"][-1]


def test_valkey_setup_is_idempotent_and_generates_a_strong_password(
    tmp_path: Path,
) -> None:
    env_file = tmp_path / ".env"
    command = ["bash", _shell_path(SERVICE_DIR / "setup.sh"), _shell_path(tmp_path)]
    subprocess.run(command, check=True)
    first = env_file.read_text(encoding="utf-8")
    subprocess.run(command, check=True)

    assert env_file.read_text(encoding="utf-8") == first
    password = first.removeprefix("VALKEY_PASSWORD=").strip()
    assert len(password) == 64
    assert all(character in "0123456789abcdef" for character in password)
