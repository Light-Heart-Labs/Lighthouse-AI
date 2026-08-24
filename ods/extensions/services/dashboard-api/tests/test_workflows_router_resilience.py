"""Unit test suite for workflows router resilience."""

from unittest.mock import patch, AsyncMock
import pytest


@pytest.mark.asyncio
async def test_workflows_router_import():
    from routers.workflows import router
    assert router is not None
