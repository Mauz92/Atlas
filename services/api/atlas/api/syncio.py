"""Helpers shared by the sync-mode write endpoints (SYNC-03; SYNC_PROTOCOL.md section 6.1)."""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from typing import Any

from fastapi import Request
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from ..sync.fields import FieldConflict, FieldResolution
from ..sync.protocol import SyncError
from ..sync.resolution_log import UNSET as _NO_LOSER
from ..sync.resolution_log import NewResolution, ResolutionLog
from ..sync.resolution_rules import (
    EDIT_WINS_OVER_DELETE,
    PATH_COLLISION,
    PATH_LATER_WINS,
    SIMPLE_LATER_WINS,
)
from .schemas import SyncConflictOut, SyncResolutionOut, SyncResult

REPLAYED_HEADER = {"Idempotency-Replayed": "true"}


def require_key(sync: bool, key: str | None) -> None:
    """Sync mode: every write carries an ``Idempotency-Key`` (retries must be safe)."""
    if sync and not key:
        raise SyncError(
            422, "idempotency_key_required", "sync-mode writes require an Idempotency-Key header"
        )


def require_base(sync: bool, base_revision: int | None) -> int | None:
    """Sync mode: updates and deletes name the revision the client's change was based on."""
    if sync and base_revision is None:
        raise SyncError(
            422, "base_revision_required", "sync-mode updates and deletes require base_revision"
        )
    return base_revision


async def reject_unknown_fields(request: Request, model: type[BaseModel]) -> None:
    """Sync mode rejects request fields the server does not know, so an old client cannot
    half-write a record whose newer fields it silently dropped (SYNC_PROTOCOL.md section 10.2)."""
    try:
        body = await request.json()
    except ValueError:
        return  # FastAPI reports the malformed body itself
    if isinstance(body, dict):
        unknown = sorted(set(body) - set(model.model_fields))
        if unknown:
            raise SyncError(
                422, "unknown_fields", "unknown request fields in sync mode", fields=unknown
            )


def conflicts_out(conflicts: Iterable[FieldConflict]) -> list[SyncConflictOut]:
    return [
        SyncConflictOut(
            field=c.field,
            reason=str(c.reason),
            server_revision=c.server_revision,
            server_value=jsonable_encoder(c.server_value),
        )
        for c in conflicts
    ]


def resolutions_out(
    resolutions: Iterable[FieldResolution], *, revived: bool = False
) -> list[SyncResolutionOut]:
    out = [
        SyncResolutionOut(
            rule=r.rule,
            field=r.field,
            kept_revision=r.kept_revision,
            loser=jsonable_encoder(r.loser),
        )
        for r in resolutions
    ]
    if revived:
        out.append(SyncResolutionOut(rule="edit_wins_over_delete"))
    return out


def sync_result(
    revision: int,
    *,
    conflicts: Iterable[FieldConflict] = (),
    resolutions: Iterable[FieldResolution] = (),
    revived: bool = False,
) -> SyncResult:
    return SyncResult(
        revision=revision,
        conflicts=conflicts_out(conflicts),
        resolution=resolutions_out(resolutions, revived=revived),
    )


#: rules whose ``kept_revision`` is the revision the write produced (the response leaves it empty)
_REVISION_RULES = frozenset({EDIT_WINS_OVER_DELETE, PATH_COLLISION})
#: rules that keep the overwritten value of a simple field
_LOSER_RULES = frozenset({SIMPLE_LATER_WINS, PATH_LATER_WINS})


async def log_resolutions(
    session: AsyncSession,
    user_id: uuid.UUID,
    entity_type: str,
    entity_id: uuid.UUID,
    outs: Iterable[SyncResolutionOut],
    *,
    op_key: str | None,
    revision: int,
) -> None:
    """Write the resolutions of a sync-mode write to the log, in the write's own transaction, and
    put each entry's ``id`` into the response object (SYNC-05).

    Call it after the entity was written and before the idempotency record is stored and the
    transaction committed: the entries, the feed announcements, the write and the stored answer
    then commit or roll back together, and a replay (which returns the stored answer before any
    work) can never log again.
    """
    outs = list(outs)
    entries: list[NewResolution] = []
    for out in outs:
        if out.kept_revision is None and out.rule in _REVISION_RULES:
            out.kept_revision = revision
        loser = out.loser if out.rule in _LOSER_RULES else _NO_LOSER
        entries.append(
            NewResolution(
                entity_type=entity_type,
                entity_id=entity_id,
                rule=out.rule,
                field=out.field,
                kept_revision=out.kept_revision,
                loser=loser,
                detail=out.detail,
            )
        )
    for out, row in zip(
        outs, await ResolutionLog(session, user_id).record(entries, op_key=op_key), strict=True
    ):
        out.id = row.id


def entity_json(model: BaseModel) -> dict[str, Any]:
    return model.model_dump(mode="json")
