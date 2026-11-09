"""``GET /api/sync/wait``: a long poll that tells a running client when to pull (M8-04e).

SYNC_PROTOCOL.md 14.7. Returns ``{"head": <cursor>, "changed": <bool>}`` at once when the caller's
feed head is past ``since``, otherwise holds the request up to
``min(timeout, SYNC_WAIT_MAX_SECONDS)`` (25 s by default, under nginx's 60 s
``proxy_read_timeout``) and answers ``changed: false`` on
timeout. The answer is a **hint, never data** (no entity, no title, no count): the client compares
``head`` with its cursor and runs an ordinary pull. Open to browser sessions and device bearer
tokens; the usual ``Atlas-Sync`` (426) and ``Atlas-Epoch`` (409) checks apply; a device revoked
while it waits is answered ``401 token_revoked`` at the next poll tick. The request's database
connection is returned to the pool before waiting, so a held request costs no connection.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from collections import defaultdict
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select

from ..config import get_settings
from ..db import session_scope
from ..models import Device, User
from ..sync.protocol import SyncError
from .deps import DbSession, SyncUser, current_device_id
from .schemas import SyncWaitOut
from .sync_gate import epoch_check

router = APIRouter(prefix="/api/sync", tags=["sync"], dependencies=[Depends(epoch_check)])


class _Waiter:
    __slots__ = ("evicted",)

    def __init__(self) -> None:
        self.evicted = asyncio.Event()


class WaitRegistry:
    """Held waits per user: the oldest is released with ``changed: false`` when a new one exceeds
    the cap, so a misbehaving client cannot pile up connections (process-local, like the
    limiter)."""

    def __init__(self) -> None:
        self._waiters: dict[uuid.UUID, list[_Waiter]] = defaultdict(list)

    def acquire(self, user_id: uuid.UUID, limit: int) -> _Waiter:
        waiters = self._waiters[user_id]
        while len(waiters) >= max(1, limit):
            waiters.pop(0).evicted.set()
        waiter = _Waiter()
        waiters.append(waiter)
        return waiter

    def release(self, user_id: uuid.UUID, waiter: _Waiter) -> None:
        waiters = self._waiters.get(user_id)
        if waiters is not None and waiter in waiters:
            waiters.remove(waiter)
            if not waiters:
                self._waiters.pop(user_id, None)

    def held(self, user_id: uuid.UUID) -> int:
        return len(self._waiters.get(user_id, []))


registry = WaitRegistry()


async def _head(user_id: uuid.UUID) -> int:
    async with session_scope() as session:
        value = await session.scalar(select(User.change_seq).where(User.id == user_id))
        return int(value or 0)


async def _device_revoked(device_id: uuid.UUID) -> bool:
    async with session_scope() as session:
        revoked = await session.scalar(select(Device.revoked_at).where(Device.id == device_id))
        return revoked is not None


@router.get("/wait", response_model=SyncWaitOut)
async def wait_for_changes(
    request: Request,
    user: SyncUser,
    session: DbSession,
    since: Annotated[
        int, Query(ge=0, le=2**63 - 1, description="The cursor the client has applied.")
    ],
    timeout: Annotated[
        int, Query(ge=1, le=60, description="Seconds to hold; capped by the server (25 default).")
    ] = 25,
) -> SyncWaitOut:
    """Long poll for the caller's feed head: see the module docstring."""
    settings = get_settings()
    user_id = user.id
    device_id = current_device_id(request)
    head = int(user.change_seq)
    await session.rollback()  # authentication is done: free the connection for the hold
    if head > since:
        return SyncWaitOut(head=head, changed=True)
    if head < since:
        # The client is ahead of the server (restored from a backup): it must pull to learn that.
        return SyncWaitOut(head=head, changed=True)
    deadline = time.monotonic() + min(timeout, max(1, settings.sync_wait_max_seconds))
    waiter = registry.acquire(user_id, settings.sync_wait_max_connections)
    poll = max(0.01, settings.sync_wait_poll_seconds)
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                await asyncio.wait_for(waiter.evicted.wait(), timeout=min(poll, remaining))
                break  # a newer wait replaced this one
            except TimeoutError:
                pass
            if device_id is not None and await _device_revoked(device_id):
                error = SyncError(401, "token_revoked", "This device was signed out; sign in again")
                error.headers = {"WWW-Authenticate": "Bearer"}
                raise error
            current = await _head(user_id)
            if current != since:
                return SyncWaitOut(head=current, changed=True)
    finally:
        registry.release(user_id, waiter)
    return SyncWaitOut(head=await _head(user_id), changed=False)
