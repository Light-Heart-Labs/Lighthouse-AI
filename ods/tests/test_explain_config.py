"""Tests for configuration provenance and the public ods CLI delegation."""

import importlib.util
import json
import os
import shlex
import shutil
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).parents[1]
SCRIPT = ROOT / "scripts" / "explain-config.py"
SPEC = importlib.util.spec_from_file_location("explain_config", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def _bash_path(path: Path) -> str:
    if os.name != "nt":
        return str(path)
    resolved = path.resolve()
    drive = resolved.drive.rstrip(":").lower()
    tail = resolved.as_posix().split(":/", 1)[1]
    return f"/mnt/{drive}/{tail}"


def _fixture(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text(
        "# fixture\nODS_MODE=cloud\nAPI_TOKEN=do-not-leak\n"
        "export ENDPOINT='https://example.test/v1?a=b'\nUNKNOWN_EMAIL=person@example.test\n"
        "ODS_MODE=hybrid\nBROKEN LINE\n",
        encoding="utf-8",
    )
    schema_file = tmp_path / ".env.schema.json"
    schema_file.write_text(json.dumps({
        "required": ["ODS_MODE", "WEBUI_SECRET"],
        "properties": {
            "ODS_MODE": {"type": "string", "default": "local"},
            "API_TOKEN": {"type": "string", "secret": True},
            "ENDPOINT": {"type": "string"},
            "WEBUI_SECRET": {"type": "string", "secret": True},
            "PORT": {"type": "integer", "default": 3002},
        },
    }), encoding="utf-8")
    return env_file, schema_file


def test_report_tracks_sources_duplicates_unknowns_and_redacts_secrets(tmp_path):
    env_file, schema_file = _fixture(tmp_path)

    report = MODULE.build_report(
        env_file,
        schema_file,
        include_all=True,
        selected_keys=[],
    )
    entries = {entry["key"]: entry for entry in report["entries"]}

    assert entries["ODS_MODE"]["value"] == "hybrid"
    assert entries["ODS_MODE"]["duplicate_lines"] == [2, 6]
    assert entries["PORT"]["source"] == "schema_default"
    assert entries["PORT"]["value"] == 3002
    assert entries["WEBUI_SECRET"]["status"] == "missing_required"
    assert entries["API_TOKEN"]["value"] == "***"
    assert entries["UNKNOWN_EMAIL"]["value"] == "***"
    assert entries["UNKNOWN_EMAIL"]["status"] == "unknown"
    assert entries["ENDPOINT"]["value"].endswith("?a=b")
    assert report["malformed_lines"] == [7]


def test_check_mode_returns_two_without_printing_secret(tmp_path):
    env_file, schema_file = _fixture(tmp_path)
    result = subprocess.run(
        [
            os.fspath(shutil.which("python3") or shutil.which("python")),
            str(SCRIPT),
            "--env-file", str(env_file),
            "--schema", str(schema_file),
            "--format", "json",
            "--check",
        ],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 2
    assert "do-not-leak" not in result.stdout
    assert "person@example.test" not in result.stdout
    assert json.loads(result.stdout)["summary"]["unknown"] == 1


def test_ods_config_explain_delegates_at_the_installed_cli_boundary(tmp_path):
    install = tmp_path / "install"
    (install / "scripts").mkdir(parents=True)
    (install / "docker-compose.base.yml").touch()
    shutil.copy2(SCRIPT, install / "scripts" / SCRIPT.name)
    (install / ".env").write_text("API_TOKEN=cli-secret\nODS_VERSION=test\n", encoding="utf-8")
    (install / ".env.schema.json").write_text(json.dumps({
        "properties": {
            "API_TOKEN": {"type": "string", "secret": True},
            "ODS_VERSION": {"type": "string"},
        },
    }), encoding="utf-8")
    if os.name == "nt":
        command = [
            "bash", "-lc",
            (
                f"ODS_HOME={shlex.quote(_bash_path(install))} NO_COLOR=1 "
                f"bash {shlex.quote(_bash_path(ROOT / 'ods-cli'))} "
                "config explain --format json"
            ),
        ]
        environment = None
    else:
        command = ["bash", str(ROOT / "ods-cli"), "config", "explain", "--format", "json"]
        environment = {**os.environ, "ODS_HOME": str(install), "NO_COLOR": "1"}

    result = subprocess.run(
        command,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    entries = {entry["key"]: entry for entry in report["entries"]}
    assert entries["API_TOKEN"]["value"] == "***"
    assert "cli-secret" not in result.stdout


if __name__ == "__main__":
    tests = (
        test_report_tracks_sources_duplicates_unknowns_and_redacts_secrets,
        test_check_mode_returns_two_without_printing_secret,
        test_ods_config_explain_delegates_at_the_installed_cli_boundary,
    )
    for test in tests:
        with tempfile.TemporaryDirectory() as temporary:
            test(Path(temporary))
    print(f"PASS: {len(tests)} configuration provenance tests")
