from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
SERVICE_DIR = ROOT / "extensions" / "library" / "services" / "crawl4ai"


def _shell_path(path: Path) -> str:
    resolved = path.resolve()
    if os.name != "nt":
        return str(resolved)
    drive = resolved.drive.rstrip(":").lower()
    return f"/mnt/{drive}/{resolved.as_posix().split(':/', 1)[1]}"


def test_crawl4ai_reaches_catalog_with_swap_safe_gateway_metadata(tmp_path: Path) -> None:
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
    entry = next(item for item in catalog["extensions"] if item["id"] == "crawl4ai")
    assert entry["depends_on"] == ["litellm"]
    assert entry["llm"]["route"] == "gateway"
    assert entry["llm"]["pinning"] == "none"
    assert entry["llm"]["probe"] == {
        "kind": "custom",
        "path": "/llm/job",
        "auth": "bearer",
    }
    assert entry["features"][0]["launch"]["path"] == "/playground"


def test_crawl4ai_compose_keeps_browser_and_llm_boundaries_constrained() -> None:
    compose = yaml.safe_load((SERVICE_DIR / "compose.yaml").read_text(encoding="utf-8"))
    service = compose["services"]["crawl4ai"]

    assert service["image"] == "unclecode/crawl4ai:0.9.2"
    assert service["read_only"] is True
    assert service["cap_drop"] == ["ALL"]
    assert service["pids_limit"] == 512
    assert service["deploy"]["resources"]["limits"]["pids"] == 512
    assert service["environment"]["LLM_PROVIDER"] == "openai/ods/current"
    assert service["environment"]["LLM_BASE_URL"] == "http://litellm:4000/v1"
    assert service["ports"] == [
        "${BIND_ADDRESS:-127.0.0.1}:${CRAWL4AI_PORT:-11235}:11235"
    ]


def test_crawl4ai_setup_is_idempotent_and_generates_distinct_secrets(tmp_path: Path) -> None:
    env_file = tmp_path / ".env"
    command = ["bash", _shell_path(SERVICE_DIR / "setup.sh"), _shell_path(tmp_path)]
    subprocess.run(command, check=True)
    first = env_file.read_text(encoding="utf-8")
    subprocess.run(command, check=True)

    assert env_file.read_text(encoding="utf-8") == first
    values = dict(line.split("=", 1) for line in first.splitlines())
    assert len(values["CRAWL4AI_API_TOKEN"]) == 64
    assert len(values["CRAWL4AI_SECRET_KEY"]) == 64
    assert values["CRAWL4AI_API_TOKEN"] != values["CRAWL4AI_SECRET_KEY"]
