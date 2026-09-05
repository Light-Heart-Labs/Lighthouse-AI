"""Tests for the installation-context builder's live model probe."""

import importlib.util
import logging
import sys
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "build-installation-context.py"
SPEC = importlib.util.spec_from_file_location("build_installation_context", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def test_loaded_model_logs_when_all_endpoints_fail(monkeypatch, caplog):
    def unavailable(url, timeout):
        raise OSError(f"unavailable: {url} after {timeout}s")

    monkeypatch.setattr("urllib.request.urlopen", unavailable)

    with caplog.at_level(logging.DEBUG, logger="build-installation-context"):
        result = MODULE._loaded_model(18080)

    assert result is None
    assert caplog.text.count("Loaded-model probe failed") == 2
    assert "Could not probe the loaded model on port 18080" in caplog.text
    assert "/api/v1/health" in caplog.text
    assert "/v1/models" in caplog.text
