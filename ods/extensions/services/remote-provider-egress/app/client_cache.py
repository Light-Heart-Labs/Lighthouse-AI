"""Bounded lifecycle management for asynchronously closable clients."""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from collections.abc import Callable
from typing import Protocol, TypeVar


class AsyncClosable(Protocol):
    is_closed: bool

    async def aclose(self) -> None: ...


ClientT = TypeVar("ClientT", bound=AsyncClosable)


class AsyncClientCache:
    """LRU cache that never closes a client while it is leased."""

    def __init__(self, factory: Callable[[], ClientT], max_size: int) -> None:
        if max_size < 1:
            raise ValueError("max_size must be at least 1")
        self._factory = factory
        self._max_size = max_size
        self._clients: OrderedDict[str, ClientT] = OrderedDict()
        self._users: dict[str, int] = {}
        self._lock = asyncio.Lock()

    @property
    def keys(self) -> tuple[str, ...]:
        return tuple(self._clients)

    def __len__(self) -> int:
        return len(self._clients)

    async def acquire(self, key: str) -> ClientT:
        async with self._lock:
            client = self._clients.pop(key, None)
            if client is None or client.is_closed:
                client = self._factory()
            self._clients[key] = client
            self._users[key] = self._users.get(key, 0) + 1
            await self._trim_locked()
            return client

    async def release(self, key: str) -> None:
        async with self._lock:
            current = self._users.get(key, 0)
            self._users[key] = max(0, current - 1)
            await self._trim_locked()

    async def close(self) -> None:
        async with self._lock:
            clients = tuple(self._clients.values())
            self._clients.clear()
            self._users.clear()
            for client in clients:
                await client.aclose()

    async def _trim_locked(self) -> None:
        while len(self._clients) > self._max_size:
            idle_key = next(
                (key for key in self._clients if self._users.get(key, 0) == 0),
                None,
            )
            if idle_key is None:
                return
            stale_client = self._clients.pop(idle_key)
            self._users.pop(idle_key, None)
            await stale_client.aclose()
