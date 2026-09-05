"""Regression tests for extension catalog validation (upstream issue #3236).

``load_extension_catalog`` previously returned the raw ``extensions`` list with
zero validation. A malformed entry (e.g. missing ``id``) flowed straight into
the catalog router, where ``ext["id"]`` raised ``KeyError`` and a missing
``gpu_backends`` misled the compatibility computation. These tests pin the
corrected behaviour: malformed entries are skipped with a logged warning.
"""

from pathlib import Path

import pytest

import config
from config import load_extension_catalog


def _write_catalog(tmp_path: Path, payload: str) -> Path:
    catalog = tmp_path / "extensions-catalog.json"
    catalog.write_text(payload, encoding="utf-8")
    return catalog


def test_catalog_skips_entries_missing_id(tmp_path, monkeypatch):
    catalog = _write_catalog(
        tmp_path,
        '{"extensions": [{"id": "good", "name": "Good"}, {"name": "NoId"}]}',
    )
    monkeypatch.setattr(config, "CATALOG_PATH", catalog)

    result = load_extension_catalog()

    assert [e["id"] for e in result] == ["good"]


def test_catalog_skips_non_object_entries(tmp_path, monkeypatch):
    catalog = _write_catalog(
        tmp_path,
        '{"extensions": [{"id": "good"}, "not-an-object", 42]}',
    )
    monkeypatch.setattr(config, "CATALOG_PATH", catalog)

    result = load_extension_catalog()

    assert [e["id"] for e in result] == ["good"]


def test_catalog_keeps_all_valid_entries(tmp_path, monkeypatch):
    catalog = _write_catalog(
        tmp_path,
        '{"extensions": [{"id": "a"}, {"id": "b", "gpu_backends": ["amd"]}]}',
    )
    monkeypatch.setattr(config, "CATALOG_PATH", catalog)

    result = load_extension_catalog()

    assert [e["id"] for e in result] == ["a", "b"]


def test_catalog_returns_empty_when_file_missing(tmp_path, monkeypatch):
    missing = tmp_path / "does-not-exist.json"
    monkeypatch.setattr(config, "CATALOG_PATH", missing)

    assert load_extension_catalog() == []


def test_catalog_returns_empty_on_invalid_json(tmp_path, monkeypatch):
    catalog = _write_catalog(tmp_path, "not valid json {{{")
    monkeypatch.setattr(config, "CATALOG_PATH", catalog)

    assert load_extension_catalog() == []
