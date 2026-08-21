"""Public-boundary tests for extension mutation previews."""

from pathlib import Path


def _write_extension(root: Path, service_id: str, *, enabled: bool, deps=()) -> Path:
    extension = root / service_id
    extension.mkdir(parents=True)
    compose_name = "compose.yaml" if enabled else "compose.yaml.disabled"
    (extension / compose_name).write_text(
        f"services:\n  {service_id}:\n    image: example/{service_id}:1\n",
        encoding="utf-8",
    )
    dependencies = "\n".join(f"      - {dep}" for dep in deps)
    manifest = f"service:\n  id: {service_id}\n"
    if dependencies:
        manifest += f"  depends_on:\n{dependencies}\n"
    (extension / "manifest.yaml").write_text(manifest, encoding="utf-8")
    return extension


def _patch_roots(monkeypatch, tmp_path):
    import routers.extensions as extensions

    roots = {
        "USER_EXTENSIONS_DIR": tmp_path / "user",
        "EXTENSIONS_DIR": tmp_path / "built-in",
        "EXTENSIONS_LIBRARY_DIR": tmp_path / "library",
    }
    for name, root in roots.items():
        root.mkdir()
        monkeypatch.setattr(extensions, name, root)
    monkeypatch.setattr(extensions, "DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(extensions, "ALWAYS_ON_SERVICES", {
        "dashboard", "dashboard-api", "llama-server", "open-webui",
    })
    return roots


def test_install_plan_describes_services_config_and_preserved_data(
    test_client, monkeypatch, tmp_path,
):
    roots = _patch_roots(monkeypatch, tmp_path)
    extension = _write_extension(roots["EXTENSIONS_LIBRARY_DIR"], "notes", enabled=True)
    (extension / "config").mkdir()

    response = test_client.get(
        "/api/extensions/notes/plan?action=install",
        headers=test_client.auth_headers,
    )

    assert response.status_code == 200
    plan = response.json()
    assert plan["can_apply"] is True
    assert plan["current_state"] == "not_installed"
    assert plan["target_state"] == "enabled"
    assert plan["affected_services"] == ["notes"]
    assert plan["steps"][2] == {"operation": "sync_config", "required": True}
    assert plan["data"]["preserved"] is True


def test_enable_plan_surfaces_dependency_choice_without_mutating_files(
    test_client, monkeypatch, tmp_path,
):
    roots = _patch_roots(monkeypatch, tmp_path)
    extension = _write_extension(
        roots["USER_EXTENSIONS_DIR"], "workflows", enabled=False, deps=("database",),
    )
    _write_extension(roots["EXTENSIONS_DIR"], "database", enabled=False)

    blocked = test_client.get(
        "/api/extensions/workflows/plan?action=enable",
        headers=test_client.auth_headers,
    ).json()
    selected = test_client.get(
        "/api/extensions/workflows/plan?action=enable&auto_enable_deps=true",
        headers=test_client.auth_headers,
    ).json()

    assert blocked["can_apply"] is False
    assert blocked["dependencies"] == ["database"]
    assert selected["can_apply"] is True
    assert selected["steps"][1] == {
        "operation": "enable_dependencies",
        "services": ["database"],
        "selected": True,
    }
    assert (extension / "compose.yaml.disabled").is_file()
    assert not (extension / "compose.yaml").exists()


def test_disable_and_uninstall_plans_report_dependents_and_preconditions(
    test_client, monkeypatch, tmp_path,
):
    roots = _patch_roots(monkeypatch, tmp_path)
    _write_extension(roots["USER_EXTENSIONS_DIR"], "database", enabled=True)
    _write_extension(
        roots["USER_EXTENSIONS_DIR"], "workflows", enabled=True, deps=("database",),
    )

    disable = test_client.get(
        "/api/extensions/database/plan?action=disable",
        headers=test_client.auth_headers,
    ).json()
    uninstall = test_client.get(
        "/api/extensions/database/plan?action=uninstall",
        headers=test_client.auth_headers,
    ).json()

    assert disable["can_apply"] is True
    assert disable["dependents"] == ["workflows"]
    assert disable["steps"][0] == {"operation": "stop", "services": ["database"]}
    assert uninstall["can_apply"] is False
    assert uninstall["blocking_reasons"] == [
        "Extension must be disabled before uninstalling",
    ]


def test_plan_rejects_unknown_actions_at_the_http_boundary(
    test_client, monkeypatch, tmp_path,
):
    _patch_roots(monkeypatch, tmp_path)

    response = test_client.get(
        "/api/extensions/notes/plan?action=restart-everything",
        headers=test_client.auth_headers,
    )

    assert response.status_code == 422
