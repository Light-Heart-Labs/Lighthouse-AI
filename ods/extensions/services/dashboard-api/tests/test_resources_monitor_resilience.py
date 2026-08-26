"""Unit test suite for resource monitoring service resilience."""

from unittest.mock import patch, MagicMock
import pytest


@pytest.mark.asyncio
async def test_resources_router_import():
    from routers.resources import router
    assert router is not None
