"""The request gate for sync mode: protocol negotiation and the epoch check (SYNC-03b)."""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Request
from fastapi.responses import JSONResponse

from ..sync.epoch import get_epoch
from ..sync.protocol import EPOCH_HEADER, SYNC_HEADER, SyncError, parse_protocol
from .deps import CurrentUser, DbSession


async def sync_gate(request: Request) -> None:
    """App-wide dependency: validates ``Atlas-Sync`` (``426`` outside the supported range).

    Sets ``request.state.sync_protocol`` (``None`` outside sync mode). It runs before
    authentication on purpose: a client that is too old must be told so even when its session has
    lapsed, and the answer reveals nothing but the supported range.
    """
    request.state.sync_protocol = parse_protocol(request.headers.get(SYNC_HEADER))


async def epoch_check(request: Request, _user: CurrentUser, session: DbSession) -> None:
    """On the sync-capable routers, after authentication: ``Atlas-Epoch`` must be the server's.

    A different epoch is ``409 epoch_mismatch`` carrying the current epoch: the server was
    restored from a backup (the operator rotates the epoch, ADR-0059 D12) or this is another
    server. The client must ask its user before adopting it; nothing is applied meanwhile. Only
    authenticated callers can learn the epoch.
    """
    if getattr(request.state, "sync_protocol", None) is None:
        return
    claimed = request.headers.get(EPOCH_HEADER)
    if claimed is None:
        return
    current = await get_epoch(session)
    if claimed.strip() != current:
        raise SyncError(
            409,
            "epoch_mismatch",
            "this server's history is not the one the client synced with "
            "(restored from a backup, or a different server); ask the user before syncing",
            epoch=current,
        )


def is_sync(request: Request) -> bool:
    return getattr(request.state, "sync_protocol", None) is not None


SyncMode = Annotated[bool, Depends(is_sync)]


def sync_error_response(_request: Request, exc: SyncError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content=exc.body())
