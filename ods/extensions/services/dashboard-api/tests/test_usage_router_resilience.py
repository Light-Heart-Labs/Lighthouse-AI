"""Unit test suite for usage metrics router resilience."""

from unittest.mock import patch, MagicMock
import pytest


@pytest.mark.asyncio
async def test_usage_router_import():
    from routers.usage import router
    assert router is not None
