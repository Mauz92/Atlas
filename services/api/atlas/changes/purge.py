"""Bounding the change feed's history: the retention purge (M7-02).

The purge removes *deletion tombstones* older than the retention cutoff from ``change_log`` so the
feed's tombstone history does not grow without bound (upserts are kept: ADR-0059 D2), while
**never** touching the user's entity rows — a soft-deleted task/project/note stays a tombstone in
its own table until the user restores or the account is removed. For each affected user it
advances ``users.change_purge_floor`` to the highest cursor it removed; that durable watermark is
what :class:`atlas.changes.service.ChangesService` uses to answer ``resync_required`` for a client
that has fallen behind (see :mod:`atlas.changes.retention`).

The delete and the floor update run in the caller's transaction. A crash therefore either purges
nothing or commits the whole bounded batch, so the purge is restart-safe; re-running with the same
cutoff removes nothing and leaves the floor unchanged, so it is idempotent. The durable job that
schedules it lives in :mod:`atlas.jobs.handlers`.

Purging removes the **tombstones** of a prefix of the cursor order (SYNC-03e): because ``seq`` and
``changed_at`` are stamped together (ADR-0032), every tombstone with a cursor below the highest
removed one is itself older than the cutoff and is removed too (upserts in that range remain, which
is intended). That is what makes ``change_purge_floor`` exact for deletions - a client at or above
the floor is guaranteed to still see every tombstone after it.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import delete, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import ChangeLog, User


@dataclass(frozen=True, slots=True)
class PurgeSummary:
    """What one purge pass removed: the cutoff used and how much it bounded."""

    cutoff: datetime
    purged: int
    users_advanced: int


class ChangePurgeService:
    """Deletes change-log rows older than the cutoff and advances the per-user purge floor."""

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def purge(self, *, cutoff: datetime) -> PurgeSummary:
        """Remove old **deletion tombstones** from ``change_log`` and advance the floors.

        SYNC-03e (ADR-0059 D2, superseding ADR-0033's scope): only ``operation = 'delete'`` rows
        older than ``cutoff`` go; ``upsert`` rows are never purged, so the log stays one row per
        existing entity and a new device can always bootstrap from cursor 0. Only ``change_log`` is
        deleted - never a task, project or note row. The floor for each user is raised to the
        highest cursor that was removed, and never lowered, so it is monotonic and a repeated pass
        is a no-op. A client at or above the floor has every remaining tombstone after it; a client
        below it (but above 0) may have missed a deletion and must resync.
        """
        removed = (
            await self.session.execute(
                delete(ChangeLog)
                .where(ChangeLog.changed_at < cutoff, ChangeLog.operation == "delete")
                .returning(ChangeLog.user_id, ChangeLog.seq)
            )
        ).all()

        floors: dict[uuid.UUID, int] = {}
        for user_id, seq in removed:
            if seq > floors.get(user_id, 0):
                floors[user_id] = seq

        for user_id, floor in floors.items():
            await self.session.execute(
                update(User)
                .where(User.id == user_id, User.change_purge_floor < floor)
                .values(change_purge_floor=floor)
            )

        return PurgeSummary(cutoff=cutoff, purged=len(removed), users_advanced=len(floors))
