"""Helpers shared by the sync-mode write endpoints (SYNC-03; SYNC_PROTOCOL.md section 6.1)."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from fastapi import Request
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel

from ..sync.fields import FieldConflict, FieldResolution
from ..sync.protocol import SyncError
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


def entity_json(model: BaseModel) -> dict[str, Any]:
    return model.model_dump(mode="json")
