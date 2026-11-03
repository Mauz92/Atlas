"""The automatic-resolution log: storing, announcing, paging and purging (SYNC-05).

Every row is written in the caller's transaction, next to the write that caused it, and announced
on the change feed (entity type ``resolution``) in that same transaction, so a device learns of a
decision through its normal pull and a rolled-back write leaves neither a row nor a feed entry.
All queries are scoped to the calling user. Nothing here logs a value: only ids, rule names and
field names reach the application log (SECURITY.md).
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import String, cast, delete, literal, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from ..changes.feed import ChangeEntityType, ChangeOperation
from ..changes.record import ChangeRecorder
from ..models import ChangeLog, SyncResolution
from .resolution_rules import (
    UNDO,
    bounded_detail,
    bounded_loser,
    decode_cursor,
    encode_cursor,
    undo_status,
)

UNSET: Any = object()


@dataclass(frozen=True, slots=True)
class NewResolution:
    """One decision to log. ``loser`` is the overwritten value of a *simple* field; leave it unset
    for every other rule (it is never text, see the module docstring of the model)."""

    entity_type: str
    entity_id: uuid.UUID
    rule: str
    field: str | None = None
    kept_revision: int | None = None
    loser: Any = UNSET
    detail: str | None = None
    undoes_id: uuid.UUID | None = None


def resolution_data(row: SyncResolution) -> dict[str, Any]:
    """The wire form of a log row (the feed ``data`` and the list/undo responses)."""
    stored = row.loser
    has_loser = stored is not None
    status = undo_status(
        rule=row.rule,
        entity_type=row.entity_type,
        entity_id=row.entity_id,
        kept_revision=row.kept_revision,
        field=row.field,
        has_loser=has_loser,
        undone=row.undone_at is not None,
    )
    return {
        "id": row.id,
        "entity_type": row.entity_type,
        "entity_id": row.entity_id,
        "rule": row.rule,
        "field": row.field,
        "kept_revision": row.kept_revision,
        "has_loser": has_loser,
        "loser": stored["value"] if stored is not None else None,
        "detail": row.detail,
        "device_id": row.device_id,
        "undoes_id": row.undoes_id,
        "undone_at": row.undone_at,
        "undone_by": row.undone_by,
        "created_at": row.created_at,
        "undoable": status.undoable,
        "undo_blocked": status.reason,
        "follow_up": (
            {"kind": status.follow_up.kind, "href": status.follow_up.href}
            if status.follow_up
            else None
        ),
    }


class ResolutionLog:
    """The caller's resolution log within one transaction."""

    def __init__(
        self, session: AsyncSession, user_id: uuid.UUID, device_id: uuid.UUID | None = None
    ) -> None:
        self.session = session
        self.user_id = user_id
        #: the device behind the request (SYNC-06): explicit, else what the authentication
        #: dependency stored on the request's session; ``None`` for a browser session
        self.device_id = device_id if device_id is not None else session.info.get("device_id")

    async def record(
        self, entries: Iterable[NewResolution], *, op_key: str | None
    ) -> list[SyncResolution]:
        """Insert one row per entry and announce each on the feed; returns the rows in order.

        ``op_key`` is the request's ``Idempotency-Key``: with the entry's position it is unique
        per user, so even a defect that ran a write twice could not log it twice (the second
        insert fails loudly and rolls the whole request back).
        """
        rows: list[SyncResolution] = []
        recorder = ChangeRecorder(self.session, self.user_id)
        for ordinal, entry in enumerate(entries):
            loser, stored = (None, False) if entry.loser is UNSET else bounded_loser(entry.loser)
            row = SyncResolution(
                id=uuid.uuid4(),
                user_id=self.user_id,
                entity_type=entry.entity_type,
                entity_id=entry.entity_id,
                rule=entry.rule,
                field=entry.field,
                kept_revision=entry.kept_revision,
                loser={"value": loser} if stored else None,
                detail=bounded_detail(entry.detail),
                device_id=self.device_id,
                op_key=op_key,
                ordinal=ordinal,
                undoes_id=entry.undoes_id,
            )
            self.session.add(row)
            await self.session.flush()
            await self.session.refresh(row)  # created_at is a server default
            await recorder.record(ChangeEntityType.RESOLUTION, str(row.id), ChangeOperation.UPSERT)
            rows.append(row)
        return rows

    async def get(
        self, resolution_id: uuid.UUID, *, for_update: bool = False
    ) -> SyncResolution | None:
        stmt = select(SyncResolution).where(
            SyncResolution.id == resolution_id, SyncResolution.user_id == self.user_id
        )
        if for_update:
            stmt = stmt.with_for_update().execution_options(populate_existing=True)
        found: SyncResolution | None = await self.session.scalar(stmt)
        return found

    async def mark_undone(self, original: SyncResolution, undo: SyncResolution) -> None:
        """Flag ``original`` as undone by ``undo`` and announce the change (devices re-read it)."""
        assert undo.rule == UNDO and undo.undoes_id == original.id
        original.undone_at = undo.created_at
        original.undone_by = undo.id
        await self.session.flush()
        await ChangeRecorder(self.session, self.user_id).record(
            ChangeEntityType.RESOLUTION, str(original.id), ChangeOperation.UPSERT
        )

    async def page(
        self,
        *,
        limit: int,
        cursor: str | None = None,
        entity_id: uuid.UUID | None = None,
        rule: str | None = None,
    ) -> tuple[Sequence[SyncResolution], str | None]:
        """Newest first. ``next`` is an opaque cursor, ``None`` on the last page."""
        stmt = select(SyncResolution).where(SyncResolution.user_id == self.user_id)
        if entity_id is not None:
            stmt = stmt.where(SyncResolution.entity_id == entity_id)
        if rule is not None:
            stmt = stmt.where(SyncResolution.rule == rule)
        if cursor is not None:
            stamp, ordinal, ident = decode_cursor(cursor)
            stmt = stmt.where(
                tuple_(SyncResolution.created_at, SyncResolution.ordinal, SyncResolution.id)
                < tuple_(literal(stamp), literal(ordinal), literal(ident))
            )
        rows = list(
            await self.session.scalars(
                stmt.order_by(
                    SyncResolution.created_at.desc(),
                    SyncResolution.ordinal.desc(),
                    SyncResolution.id.desc(),
                ).limit(limit + 1)
            )
        )
        if len(rows) <= limit:
            return rows, None
        rows = rows[:limit]
        return rows, encode_cursor(rows[-1].created_at, rows[-1].ordinal, rows[-1].id)


async def load_resolution_data(
    session: AsyncSession, user_id: uuid.UUID, ids: Iterable[uuid.UUID]
) -> dict[uuid.UUID, tuple[int, dict[str, Any]]]:
    """Feed payloads (``include=data``): ``{id: (schema revision, data)}``; the revision is 1 for a
    logged entry and 2 once it was undone, so a client applies by revision like any entity."""
    found = list(
        await session.scalars(
            select(SyncResolution).where(
                SyncResolution.user_id == user_id, SyncResolution.id.in_(list(ids))
            )
        )
    )
    return {row.id: (2 if row.undone_at else 1, resolution_data(row)) for row in found}


async def purge_resolutions(session: AsyncSession, *, cutoff: datetime) -> int:
    """Delete log rows older than ``cutoff`` and their feed rows; returns how many.

    The feed row of a purged resolution goes with it (no tombstone: a resolution is a notice, not
    state, and a client drops notices older than the retention window by itself). Entities are
    never touched. Safe to repeat.
    """
    expired = select(cast(SyncResolution.id, String)).where(SyncResolution.created_at < cutoff)
    await session.execute(
        delete(ChangeLog).where(
            ChangeLog.entity_type == ChangeEntityType.RESOLUTION, ChangeLog.entity_id.in_(expired)
        )
    )
    removed = await session.execute(
        delete(SyncResolution)
        .where(SyncResolution.created_at < cutoff)
        .returning(SyncResolution.id)
    )
    return len(removed.all())
