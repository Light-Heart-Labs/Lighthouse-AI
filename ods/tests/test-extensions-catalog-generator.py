#!/usr/bin/env python3
"""Unit tests for scripts/generate-extensions-catalog.py."""

from __future__ import annotations

import importlib.util
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "generate-extensions-catalog.py"


def load_module():
    spec = importlib.util.spec_from_file_location("generate_extensions_catalog", SCRIPT)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_strip_secrets_removes_secret_field() -> None:
    module = load_module()
    env_vars = [
        {"key": "API_KEY", "secret": True, "required": True},
        {"key": "PORT", "required": False},
    ]
    cleaned = module.strip_secrets(env_vars)
    assert cleaned == [
        {"key": "API_KEY", "required": True},
        {"key": "PORT", "required": False},
    ]


def test_load_manifest_accepts_valid_schema(tmp_path: Path) -> None:
    module = load_module()
    manifest_path = tmp_path / "manifest.yaml"
    manifest_path.write_text(
        "schema_version: ods.services.v1\nservice:\n  id: example\n",
        encoding="utf-8",
    )
    data = module.load_manifest(manifest_path)
    assert data is not None
    assert data["service"]["id"] == "example"


def test_load_manifest_rejects_wrong_schema_version(tmp_path: Path) -> None:
    module = load_module()
    manifest_path = tmp_path / "manifest.yaml"
    manifest_path.write_text(
        "schema_version: ods.services.v0\nservice:\n  id: example\n",
        encoding="utf-8",
    )
    assert module.load_manifest(manifest_path) is None


def test_load_manifest_rejects_non_mapping_root(tmp_path: Path) -> None:
    module = load_module()
    manifest_path = tmp_path / "manifest.yaml"
    manifest_path.write_text("- just\n- a\n- list\n", encoding="utf-8")
    assert module.load_manifest(manifest_path) is None


def test_load_manifest_rejects_invalid_yaml(tmp_path: Path) -> None:
    module = load_module()
    manifest_path = tmp_path / "manifest.yaml"
    manifest_path.write_text("service: [unterminated\n", encoding="utf-8")
    assert module.load_manifest(manifest_path) is None


def test_extract_entry_builds_expected_fields() -> None:
    module = load_module()
    manifest = {
        "schema_version": "ods.services.v1",
        "tags": ["chat"],
        "service": {
            "id": "example",
            "name": "Example",
            "description": "An example service",
            "category": "general",
            "gpu_backends": ["cpu"],
            "compose_file": "compose.yaml",
            "depends_on": [],
            "port": 8080,
            "external_port_default": 8080,
            "health": "/health",
            "env_vars": [{"key": "API_KEY", "secret": True}],
        },
    }
    entry = module.extract_entry(manifest)
    assert entry is not None
    assert entry["id"] == "example"
    assert entry["health_endpoint"] == "/health"
    assert entry["env_vars"] == [{"key": "API_KEY"}]
    assert entry["tags"] == ["chat"]
    assert "llm" not in entry
    assert "startup_check" not in entry


def test_extract_entry_includes_optional_llm_and_startup_fields() -> None:
    module = load_module()
    manifest = {
        "service": {
            "id": "example",
            "llm": {"model": "some-model"},
            "startup_check": "curl -f http://localhost/health",
            "startup_timeout": 30,
        },
    }
    entry = module.extract_entry(manifest)
    assert entry is not None
    assert entry["llm"] == {"model": "some-model"}
    assert entry["startup_check"] == "curl -f http://localhost/health"
    assert entry["startup_timeout"] == 30


def test_extract_entry_rejects_missing_service_block() -> None:
    module = load_module()
    assert module.extract_entry({"tags": []}) is None


def test_extract_entry_rejects_invalid_service_id() -> None:
    module = load_module()
    assert module.extract_entry({"service": {"id": "Invalid ID!"}}) is None
    assert module.extract_entry({"service": {}}) is None


def test_extract_entry_excludes_privacy_shield() -> None:
    module = load_module()
    assert module.extract_entry({"service": {"id": "privacy-shield"}}) is None


def test_generate_catalog_sorts_and_skips_incomplete_dirs() -> None:
    module = load_module()
    with tempfile.TemporaryDirectory() as tmp:
        library_dir = Path(tmp)

        zebra = library_dir / "zebra-service"
        zebra.mkdir()
        (zebra / "manifest.yaml").write_text(
            "schema_version: ods.services.v1\nservice:\n  id: zebra\n",
            encoding="utf-8",
        )

        apple = library_dir / "apple-service"
        apple.mkdir()
        (apple / "manifest.yaml").write_text(
            "schema_version: ods.services.v1\nservice:\n  id: apple\n",
            encoding="utf-8",
        )

        # No manifest.yaml at all - must be skipped, not crash the scan.
        (library_dir / "empty-dir").mkdir()

        # A stray file next to the service directories - must be skipped.
        (library_dir / "README.md").write_text("not a service\n", encoding="utf-8")

        entries = module.generate_catalog(library_dir)

    assert [entry["id"] for entry in entries] == ["apple", "zebra"]


def test_generate_catalog_exits_when_library_dir_missing() -> None:
    module = load_module()
    with tempfile.TemporaryDirectory() as tmp:
        missing = Path(tmp) / "does-not-exist"
        try:
            module.generate_catalog(missing)
        except SystemExit as exc:
            assert exc.code == 1
        else:
            raise AssertionError("generate_catalog should exit(1) for a missing library dir")


def test_repo_library_generates_without_crashing() -> None:
    module = load_module()
    library_dir = ROOT / "extensions" / "library" / "services"
    entries = module.generate_catalog(library_dir)
    assert len(entries) > 0
    assert "privacy-shield" not in {entry["id"] for entry in entries}
    ids = [entry["id"] for entry in entries]
    assert ids == sorted(ids)


def main() -> int:
    tests = [
        test_strip_secrets_removes_secret_field,
        test_extract_entry_builds_expected_fields,
        test_extract_entry_includes_optional_llm_and_startup_fields,
        test_extract_entry_rejects_missing_service_block,
        test_extract_entry_rejects_invalid_service_id,
        test_extract_entry_excludes_privacy_shield,
        test_generate_catalog_sorts_and_skips_incomplete_dirs,
        test_generate_catalog_exits_when_library_dir_missing,
        test_repo_library_generates_without_crashing,
    ]
    for test in tests:
        test()

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        test_load_manifest_accepts_valid_schema(tmp_path)
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        test_load_manifest_rejects_wrong_schema_version(tmp_path)
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        test_load_manifest_rejects_non_mapping_root(tmp_path)
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        test_load_manifest_rejects_invalid_yaml(tmp_path)

    print("[PASS] extensions catalog generator tests")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
