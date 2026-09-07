"""Egress HTTP client caching for dashboard-api."""

from __future__ import annotations

import os
from collections import OrderedDict
from typing import Optional

import httpx

from config import DATA_DIR


MAX_EGRESS_CLIENTS = int(os.environ.get("ODS_DASHBOARD_API_MAX_EGRESS_CLIENTS", "50"))
_EGRESS_TIMEOUT_SECONDS = float(
    os.environ.get("ODS_DASHBOARD_API_EGRESS_TIMEOUT", "3.0")
)


class _EgressClientState:
    """Singleton-like state for egress HTTP clients."""

    def __init__(self) -> None:
        self._client: Optional[httpx.AsyncClient] = None
        self._direct_clients: Optional[OrderedDict] = None

    async def get_client(self, connection_key: str = "") -> httpx.AsyncClient:
        """Get an HTTP client for egress calls, with LRU bounding for connection-keyed clients."""
        if connection_key:
            # Lazy initialize direct clients dict
            if self._direct_clients is None:
                self._direct_clients = OrderedDict()

            # Return existing client if found, move to end (most recently used)
            if connection_key in self._direct_clients:
                client = self._direct_clients[connection_key]
                self._direct_clients.move_to_end(connection_key)
                return client

            # Evict oldest if at capacity
            if len(self._direct_clients) >= MAX_EGRESS_CLIENTS:
                oldest_key, oldest_client = self._direct_clients.popitem(last=False)
                await oldest_client.aclose()

            # Create and cache new client
            client = httpx.AsyncClient(timeout=_EGRESS_TIMEOUT_SECONDS)
            self._direct_clients[connection_key] = client
            return client

        # Return shared client for empty connection key
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=_EGRESS_TIMEOUT_SECONDS)
        return self._client

    async def aclose(self) -> None:
        """Close all cached clients."""
        if self._client:
            await self._client.aclose()
            self._client = None

        if self._direct_clients:
            for client in self._direct_clients.values():
                await client.aclose()
            self._direct_clients.clear()


# Global instance
_egress_client_state = _EgressClientState()


async def get_egress_client(connection_key: str = "") -> httpx.AsyncClient:
    """Get an HTTP client for egress service calls."""
    return await _egress_client_state.get_client(connection_key)


async def close_egress_clients() -> None:
    """Close all egress HTTP clients (call on shutdown)."""
    await _egress_client_state.aclose()
