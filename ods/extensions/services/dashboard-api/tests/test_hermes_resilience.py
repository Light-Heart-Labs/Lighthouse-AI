import asyncio
import os
import pytest
from unittest.mock import AsyncMock, patch
from hermes_bridge import (
    _connect_ws,
    _fetch_hermes_token,
    HermesUnavailable,
)
import aiohttp


@pytest.mark.asyncio
async def test_hermes_auth_fails_closed():
    """
    Verifies that when HERMES_SAFE_MODE is OFF (default),
    a failure to fetch the token raises HermesUnavailable.
    """
    # Ensure safe mode is OFF
    if "HERMES_SAFE_MODE" in os.environ:
        del os.environ["HERMES_SAFE_MODE"]

    mock_session = AsyncMock(spec=aiohttp.ClientSession)

    # Mock _fetch_hermes_token to raise HermesUnavailable
    with patch(
        "hermes_bridge._fetch_hermes_token",
        side_effect=HermesUnavailable("Token fetch failed"),
    ):
        with pytest.raises(HermesUnavailable, match="Token fetch failed"):
            await _connect_ws(mock_session)


@pytest.mark.asyncio
async def test_hermes_safe_mode_skips_token():
    """
    Verifies that when HERMES_SAFE_MODE=1, _fetch_hermes_token is skipped
    and the connection is attempted with an empty token.
    """
    os.environ["HERMES_SAFE_MODE"] = "1"

    mock_session = AsyncMock(spec=aiohttp.ClientSession)
    # Mock ws_connect to simulate a successful connection attempt
    mock_ws = AsyncMock(spec=aiohttp.ClientWebSocketResponse)
    # In AsyncMock, we should set the return_value of the mocked method.
    # Since ws_connect is awaited, we need the mock to be an awaitable that returns mock_ws.
    mock_session.ws_connect.return_value = asyncio.Future()
    mock_session.ws_connect.return_value.set_result(mock_ws)

    with patch(
        "hermes_bridge._fetch_hermes_token",
        wraps=_fetch_hermes_token,
    ) as mock_fetch:
        await _connect_ws(mock_session)

        # Token fetch should NOT have been called
        mock_fetch.assert_not_called()

        # Verify ws_connect was called with empty token in URL
        args, _ = mock_session.ws_connect.call_args
        url = args[0]
        assert "token=" in url
        assert url.endswith("token=")


@pytest.mark.asyncio
async def test_hermes_safe_mode_still_fails_on_connection_error():
    """
    Verifies that even in safe mode, if the WebSocket connection itself fails,
    it still raises HermesUnavailable (no silent swallowing).
    """
    os.environ["HERMES_SAFE_MODE"] = "1"

    mock_session = AsyncMock(spec=aiohttp.ClientSession)
    # Simulate a connection failure
    mock_session.ws_connect.side_effect = aiohttp.ClientConnectorError(
        connection_key=None, os_error=OSError("Connection refused")
    )

    with pytest.raises(
        HermesUnavailable, match="Hermes JSON-RPC websocket is not reachable"
    ):
        await _connect_ws(mock_session)

    # Clean up env
    del os.environ["HERMES_SAFE_MODE"]
