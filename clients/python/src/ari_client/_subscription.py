"""One stream of items (`session/events`, ...) as an asyncio `AsyncIterator`."""

from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable, Generic, TypeVar

from ._codec import AriCallError

T = TypeVar("T")

END = object()
"""Put on a stream's queue after its last item."""


class Subscription(Generic[T]):
    """The items of one stream, in order. Iteration ends after the driver's `stream/end`; a stream
    that failed raises its `AriCallError` instead."""

    def __init__(self, stream_id: str, queue: asyncio.Queue[Any], decode: Callable[[Any], T], cancel: Callable[[], Awaitable[None]]) -> None:
        self.stream_id = stream_id
        self._queue = queue
        self._decode = decode
        self._cancel = cancel
        self._done = False

    def __aiter__(self) -> Subscription[T]:
        return self

    async def __anext__(self) -> T:
        if self._done:
            raise StopAsyncIteration
        item = await self._queue.get()
        if item is END:
            self._done = True
            raise StopAsyncIteration
        if isinstance(item, AriCallError):
            self._done = True
            raise item
        return self._decode(item)

    async def cancel(self) -> None:
        """Asks the driver to stop the stream; it then sends `stream/end`."""
        await self._cancel()
