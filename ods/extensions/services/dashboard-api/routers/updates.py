"""Version checking and update endpoints."""

import asyncio
import json
import logging
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, TypedDict

import httpx
from fastapi import APIRouter, Depends, HTTPException

from config import INSTALL_DIR
from env_values import strip_matching_quotes
from host_agent_client import (
    AgentHTTPError,
    AgentUnavailable,
    request_text as request_agent_text,
)
from models import VersionInfo, UpdateAction
from security import verify_api_key

logger = logging.getLogger(__name__)

router = APIRouter(tags=["updates"])

_VALID_ACTIONS = {"check", "backup", "update"}

_GITHUB_REPOSITORY = "Osmantic/ODS"
_GITHUB_RELEASES_API = f"https://api.github.com/repos/{_GITHUB_REPOSITORY}/releases"
_GITHUB_RELEASES_PAGE = f"https://github.com/{_GITHUB_REPOSITORY}/releases"
_GITHUB_HEADERS = {"Accept": "application/vnd.github.v3+json"}
_VERSION_CACHE_TTL = 300.0


class _VersionCache(TypedDict):
    expires_at: float
    payload: Optional[dict]


_version_cache: _VersionCache = {"expires_at": 0.0, "payload": None}
_version_refresh_task: Optional[asyncio.Task] = None


def _read_utf8(path: Path) -> str:
    """Read repository text files consistently across Windows and Linux."""
    return path.read_text(encoding="utf-8")


def _read_current_version() -> str:
    """Read installed version from .env (preferred) or .version file."""
    env_file = Path(INSTALL_DIR) / ".env"
    if env_file.exists():
        try:
            for line in _read_utf8(env_file).splitlines():
                if line.startswith("ODS_VERSION="):
                    return strip_matching_quotes(line.split("=", 1)[1])
        except OSError:
            pass
    version_file = Path(INSTALL_DIR) / ".version"
    if version_file.exists():
        try:
            raw = _read_utf8(version_file).strip()
            if raw:
                if raw.startswith("{"):
                    data = json.loads(raw)
                    if isinstance(data, dict) and data.get("version"):
                        return str(data["version"])
                return raw
        except (OSError, json.JSONDecodeError, ValueError):
            pass
    manifest_file = Path(INSTALL_DIR) / "manifest.json"
    if manifest_file.exists():
        try:
            data = json.loads(_read_utf8(manifest_file))
            version = (
                data.get("release", {}).get("version")
                or data.get("ods_version")
                or data.get("manifestVersion")
            )
            if version:
                return str(version)
        except (OSError, json.JSONDecodeError, ValueError, AttributeError):
            pass
    main_file = Path(__file__).resolve().parents[1] / "main.py"
    if main_file.exists():
        try:
            match = re.search(r'version\s*=\s*"([^"]+)"', _read_utf8(main_file))
            if match:
                return match.group(1)
        except OSError:
            pass
    return "0.0.0"


def _call_update_agent(endpoint_action: str, payload: dict, timeout: int) -> dict:
    """Call the host agent for update execution."""
    try:
        raw = request_agent_text(
            "POST",
            f"/v1/update/{endpoint_action}",
            payload=payload,
            timeout=timeout,
        )
    except AgentHTTPError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    except AgentUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"Host agent unreachable: {exc}") from exc

    try:
        parsed = json.loads(raw or "{}")
    except json.JSONDecodeError:
        parsed = {"success": False, "output": raw}
    return parsed if isinstance(parsed, dict) else {"success": False, "output": raw}


def _get_update_agent_status(timeout: int = 5) -> dict:
    try:
        raw = request_agent_text("GET", "/v1/update/status", timeout=timeout)
    except AgentHTTPError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    except AgentUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"Host agent unreachable: {exc}") from exc

    try:
        parsed = json.loads(raw or "{}")
    except json.JSONDecodeError:
        parsed = {"status": "unknown", "output": raw}
    return parsed if isinstance(parsed, dict) else {"status": "unknown", "output": raw}


def _get_cached_release_payload(allow_stale: bool = False) -> Optional[dict]:
    payload = _version_cache.get("payload")
    if payload is None:
        return None
    if allow_stale or time.monotonic() < _version_cache["expires_at"]:
        return payload
    return None


def _normalize_version(value: Optional[str]) -> str:
    """Normalize a version string for comparison and display.

    GitHub release tags are ``vX.Y.Z`` while ``.env``/``.version`` may store
    either form, so strip a leading ``v`` (and surrounding whitespace) to keep
    ``current`` and ``latest`` on the same footing.
    """
    return (value or "").strip().lstrip("v")


def _parse_latest_release_response(response: httpx.Response) -> dict[str, Optional[str]]:
    """Validate GitHub's latest-release contract before consumers use it."""
    response.raise_for_status()
    data = response.json()
    if not isinstance(data, dict):
        raise httpx.HTTPError(
            f"unexpected release response: {type(data).__name__}"
        )

    tag = data.get("tag_name")
    if not isinstance(tag, str) or not _normalize_version(tag):
        raise httpx.HTTPError("release response carried no valid tag_name")

    changelog_url = data.get("html_url")
    if changelog_url is not None and not isinstance(changelog_url, str):
        raise httpx.HTTPError("release response carried an invalid html_url")

    return {
        "latest": _normalize_version(tag),
        "changelog_url": changelog_url or None,
    }


def _parse_release_manifest_response(response: httpx.Response) -> list[dict]:
    """Validate and normalize GitHub's release-list response."""
    response.raise_for_status()
    data = response.json()
    if not isinstance(data, list):
        raise httpx.HTTPError(
            f"unexpected releases response: {type(data).__name__}"
        )

    releases = []
    for index, release in enumerate(data):
        if not isinstance(release, dict):
            raise httpx.HTTPError(f"release {index} was not an object")

        tag = release.get("tag_name")
        if not isinstance(tag, str) or not _normalize_version(tag):
            raise httpx.HTTPError(f"release {index} carried no valid tag_name")

        text = {}
        for field in ("published_at", "name", "body", "html_url"):
            value = release.get(field)
            if value is not None and not isinstance(value, str):
                raise httpx.HTTPError(f"release {index} carried an invalid {field}")
            text[field] = value or ""

        prerelease = release.get("prerelease", False)
        if not isinstance(prerelease, bool):
            raise httpx.HTTPError(f"release {index} carried an invalid prerelease")

        body = text["body"]
        releases.append(
            {
                "version": _normalize_version(tag),
                "date": text["published_at"],
                "title": text["name"],
                "changelog": body[:500] + "..." if len(body) > 500 else body,
                "url": text["html_url"],
                "prerelease": prerelease,
            }
        )
    return releases


def _build_version_result(current: str, payload: Optional[dict]) -> dict:
    current = _normalize_version(current)
    result = {
        "current": current,
        "latest": None,
        "update_available": False,
        "changelog_url": None,
        "checked_at": datetime.now(timezone.utc).isoformat(),
    }
    if not payload:
        return result

    latest = _normalize_version(payload.get("latest"))
    if not latest:
        return result

    result["latest"] = latest
    result["changelog_url"] = payload.get("changelog_url")
    result["checked_at"] = payload.get("checked_at") or result["checked_at"]

    current_parts = [int(x) for x in current.split(".") if x.isdigit()][:3]
    latest_parts = [int(x) for x in latest.split(".") if x.isdigit()][:3]
    current_parts += [0] * (3 - len(current_parts))
    latest_parts += [0] * (3 - len(latest_parts))
    result["update_available"] = latest_parts > current_parts
    return result


async def _refresh_release_cache() -> Optional[dict]:
    global _version_cache
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(
                f"{_GITHUB_RELEASES_API}/latest",
                headers=_GITHUB_HEADERS,
            )
        release = _parse_latest_release_response(response)
        payload = {
            **release,
            "checked_at": datetime.now(timezone.utc).isoformat(),
        }
        _version_cache = {
            "expires_at": time.monotonic() + _VERSION_CACHE_TTL,
            "payload": payload,
        }
        return payload
    except (httpx.HTTPError, httpx.TimeoutException, json.JSONDecodeError, OSError, ValueError):
        return _get_cached_release_payload(allow_stale=True)


def _ensure_release_refresh() -> asyncio.Task:
    global _version_refresh_task
    if _version_refresh_task is None or _version_refresh_task.done():
        _version_refresh_task = asyncio.create_task(_refresh_release_cache())
    return _version_refresh_task


@router.get("/api/version", response_model=VersionInfo, dependencies=[Depends(verify_api_key)])
async def get_version():
    """Get current ODS version without blocking page load on GitHub."""
    current = await asyncio.to_thread(_read_current_version)
    cached = _get_cached_release_payload()
    if cached:
        return _build_version_result(current, cached)

    stale = _get_cached_release_payload(allow_stale=True)
    refresh_task = _ensure_release_refresh()

    if stale:
        return _build_version_result(current, stale)

    try:
        payload = await asyncio.wait_for(asyncio.shield(refresh_task), timeout=1.25)
        return _build_version_result(current, payload)
    except asyncio.TimeoutError:
        logger.debug("Version refresh still in progress; returning local version immediately")
        return _build_version_result(current, None)


@router.get("/api/releases/manifest", dependencies=[Depends(verify_api_key)])
async def get_release_manifest():
    """Get release manifest with version history (non-blocking)."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                f"{_GITHUB_RELEASES_API}?per_page=5",
                headers=_GITHUB_HEADERS,
            )
        releases = _parse_release_manifest_response(resp)
        return {
            "releases": releases,
            "checked_at": datetime.now(timezone.utc).isoformat()
        }
    except (httpx.HTTPError, httpx.TimeoutException, json.JSONDecodeError, OSError):
        current = await asyncio.to_thread(_read_current_version)
        return {
            "releases": [{"version": current, "date": datetime.now(timezone.utc).isoformat(), "title": f"ODS {current}", "changelog": "Release information unavailable. Check GitHub directly.", "url": _GITHUB_RELEASES_PAGE, "prerelease": False}],
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "error": "Could not fetch release information"
        }


_UPDATE_ENV_KEYS = {
    "ODS_VERSION", "TIER", "LLM_MODEL", "GGUF_FILE",
    "CTX_SIZE", "GPU_BACKEND", "N_GPU_LAYERS",
}


@router.get("/api/update/dry-run", dependencies=[Depends(verify_api_key)])
async def get_update_dry_run():
    """Preview what a ods update would change without applying anything.

    Returns version comparison, configured image tags, and the .env keys
    that the update process reads or writes.  No containers are started,
    stopped, or re-created.
    """
    install_path = Path(INSTALL_DIR)

    # ── current version ───────────────────────────────────────────────────────
    current = "0.0.0"
    env_file = install_path / ".env"
    version_file = install_path / ".version"

    if env_file.exists():
        for line in _read_utf8(env_file).splitlines():
            if line.startswith("ODS_VERSION="):
                current = strip_matching_quotes(line.split("=", 1)[1])
                break
    if current == "0.0.0" and version_file.exists():
        try:
            raw = _read_utf8(version_file).strip()
            parsed = json.loads(raw) if raw.startswith("{") else None
            current = (parsed or {}).get("version", raw) or raw or "0.0.0"
        except (json.JSONDecodeError, OSError):
            pass
    current = _normalize_version(current)

    # ── latest version from GitHub ────────────────────────────────────────────
    latest: Optional[str] = None
    changelog_url: Optional[str] = None
    update_available = False
    version_check_error: Optional[str] = None

    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.get(
                f"{_GITHUB_RELEASES_API}/latest",
                headers=_GITHUB_HEADERS,
            )
        release = _parse_latest_release_response(resp)
        latest = release["latest"]
        changelog_url = release["changelog_url"]
        if latest:
            def _parts(v: str) -> list[int]:
                return ([int(x) for x in v.split(".") if x.isdigit()][:3] + [0, 0, 0])[:3]
            update_available = _parts(latest) > _parts(current)
    except (httpx.HTTPError, httpx.TimeoutException, OSError, json.JSONDecodeError, ValueError) as e:
        version_check_error = f"Could not reach GitHub: {e}"

    # ── configured image tags from compose files ──────────────────────────────
    images: list[str] = []
    for compose_file in sorted(install_path.glob("docker-compose*.yml")):
        try:
            for line in _read_utf8(compose_file).splitlines():
                stripped = line.strip()
                if stripped.startswith("image:"):
                    tag = stripped.split(":", 1)[1].strip()
                    if tag and tag not in images:
                        images.append(tag)
        except OSError:
            pass

    # ── .env keys relevant to the update path ────────────────────────────────
    env_snapshot: dict[str, str] = {}
    if env_file.exists():
        for line in _read_utf8(env_file).splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            if key in _UPDATE_ENV_KEYS:
                env_snapshot[key] = val

    return {
        "dry_run": True,
        "current_version": current,
        "latest_version": latest,
        "update_available": update_available,
        "changelog_url": changelog_url,
        "images": images,
        "env_keys": env_snapshot,
        "version_check_error": version_check_error,
    }


@router.get("/api/update/status", dependencies=[Depends(verify_api_key)])
async def get_update_status():
    """Return host-agent managed update status."""
    return await asyncio.to_thread(_get_update_agent_status)


@router.post("/api/update")
async def trigger_update(action: UpdateAction, api_key: str = Depends(verify_api_key)):
    """Trigger update actions via dashboard."""
    if action.action not in _VALID_ACTIONS:
        raise HTTPException(status_code=400, detail=f"Unknown action: {action.action}")

    if action.action == "check":
        return await asyncio.to_thread(_call_update_agent, "check", {}, 35)
    if action.action == "backup":
        payload = {"backup_id": f"dashboard-{datetime.now().strftime('%Y%m%d-%H%M%S')}"}
        return await asyncio.to_thread(_call_update_agent, "backup", payload, 65)

    return await asyncio.to_thread(_call_update_agent, "start", {}, 10)
