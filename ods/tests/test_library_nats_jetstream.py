from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
SERVICE_DIR = ROOT / "extensions" / "library" / "services" / "nats-jetstream"


def _shell_path(path: Path) -> str:
    resolved = path.resolve()
    if os.name != "nt":
        return str(resolved)
    drive = resolved.drive.rstrip(":").lower()
    return f"/mnt/{drive}/{resolved.as_posix().split(':/', 1)[1]}"


def test_nats_reaches_catalog_with_jetstream_only_readiness(tmp_path: Path) -> None:
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
    entry = next(
        item for item in catalog["extensions"] if item["id"] == "nats-jetstream"
    )
    assert entry["health_endpoint"] == "/healthz?js-enabled-only=true"
    assert entry["features"][0]["id"] == "nats-agent-event-bus"
    assert entry["env_vars"][0]["key"] == "NATS_PASSWORD"
    assert entry["env_vars"][1]["key"] == "NATS_JETSTREAM_KEY"


def test_nats_compose_pins_and_constrains_client_and_monitor_ports() -> None:
    compose = yaml.safe_load((SERVICE_DIR / "compose.yaml").read_text(encoding="utf-8"))
    service = compose["services"]["nats-jetstream"]

    assert service["image"] == "nats:2.14.5-alpine"
    assert service["user"] == "1000:1000"
    assert service["read_only"] is True
    assert service["cap_drop"] == ["ALL"]
    assert service["ports"] == [
        "${BIND_ADDRESS:-127.0.0.1}:${NATS_PORT:-4222}:4222",
        "${BIND_ADDRESS:-127.0.0.1}:${NATS_MONITOR_PORT:-8222}:8222",
    ]
    assert (
        "./config/nats-jetstream/nats-server.conf:"
        "/etc/nats/nats-server.conf:ro"
    ) in service["volumes"]
    assert service["healthcheck"]["test"][-1].endswith(
        "/healthz?js-enabled-only=true"
    )


def test_nats_server_config_requires_auth_and_encrypts_bounded_storage() -> None:
    config = (
        SERVICE_DIR / "config" / "nats-jetstream" / "nats-server.conf"
    ).read_text(encoding="utf-8")

    assert "password: $NATS_PASSWORD" in config
    assert "max_memory_store: $NATS_JETSTREAM_MAX_MEMORY" in config
    assert "max_file_store: $NATS_JETSTREAM_MAX_FILE" in config
    assert "encryption_key: $NATS_JETSTREAM_KEY" in config
    assert "cipher: chacha" in config
    assert 'sync_interval: "30s"' in config


def test_nats_setup_is_idempotent_and_generates_distinct_secrets(
    tmp_path: Path,
) -> None:
    env_file = tmp_path / ".env"
    command = ["bash", _shell_path(SERVICE_DIR / "setup.sh"), _shell_path(tmp_path)]
    subprocess.run(command, check=True)
    first = env_file.read_text(encoding="utf-8")
    subprocess.run(command, check=True)

    assert env_file.read_text(encoding="utf-8") == first
    values = dict(line.split("=", 1) for line in first.splitlines())
    assert set(values) == {"NATS_PASSWORD", "NATS_JETSTREAM_KEY"}
    assert all(value.startswith("nats_") for value in values.values())
    assert all(len(value) == 69 for value in values.values())
    assert len(set(values.values())) == 2
