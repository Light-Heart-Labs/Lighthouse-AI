"""Unit tests for privacy shield router status and toggle endpoints."""

from unittest.mock import patch
import pytest

from routers.privacy import get_privacy_shield_status, toggle_privacy_shield
from models import PrivacyShieldToggle


@pytest.mark.asyncio
async def test_get_privacy_shield_status_defaults_when_unreachable():
    with patch("aiohttp.ClientSession.get", side_effect=OSError("Unreachable")):
        status = await get_privacy_shield_status(api_key="valid-key")
        assert status.enabled is False
        assert status.container_running is False
        assert "not running" in status.message


@pytest.mark.asyncio
async def test_toggle_privacy_shield_start_action():
    with patch("routers.privacy.request_agent_json", return_value={"status": "ok"}):
        req = PrivacyShieldToggle(enable=True)
        res = await toggle_privacy_shield(req, api_key="valid-key")
        assert res["success"] is True
