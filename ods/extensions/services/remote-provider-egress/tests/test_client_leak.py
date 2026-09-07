import pytest
import httpx
from collections import OrderedDict
from fastapi import FastAPI
from app.main import app, MAX_CLIENTS, _http_client


@pytest.mark.asyncio
async def test_client_leak_bounded():
    # Setup state
    app.state.http = httpx.AsyncClient()
    app.state.direct_http_clients = OrderedDict()

    # Create more clients than MAX_CLIENTS
    for i in range(MAX_CLIENTS + 10):
        key = f"client_{i}"
        await _http_client(key)

    # Assert size is bounded to MAX_CLIENTS
    assert len(app.state.direct_http_clients) == MAX_CLIENTS

    # Verify that the first few clients were evicted
    assert "client_0" not in app.state.direct_http_clients
    assert f"client_{MAX_CLIENTS}" in app.state.direct_http_clients


@pytest.mark.asyncio
async def test_client_lru_behavior():
    app.state.http = httpx.AsyncClient()
    app.state.direct_http_clients = OrderedDict()

    # Fill to MAX_CLIENTS
    for i in range(MAX_CLIENTS):
        await _http_client(f"client_{i}")

    # Access client_0 to make it most recent
    await _http_client("client_0")

    # Add one more to trigger eviction
    await _http_client("client_new")

    # client_0 should still be there, client_1 should be gone
    assert "client_0" in app.state.direct_http_clients
    assert "client_1" not in app.state.direct_http_clients


@pytest.mark.asyncio
async def test_shutdown_closes_clients():
    from app.main import _shutdown

    app.state.http = httpx.AsyncClient()
    app.state.direct_http_clients = OrderedDict()

    # Create a few clients
    await _http_client("c1")
    await _http_client("c2")

    clients = list(app.state.direct_http_clients.values())

    await _shutdown()

    # All clients should be closed
    for client in clients:
        assert client.is_closed
    assert len(app.state.direct_http_clients) == 0
