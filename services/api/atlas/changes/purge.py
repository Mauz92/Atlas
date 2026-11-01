"""Bounding the change feed's history: the retention purge (M7-02).

The purge removes ``change_log`` rows older than the retention cutoff so the feed's tombstone
history does not grow without bound, while **never** touching the user's entity rows — a
soft-deleted task/project/note stays a tombstone in its own table until the user restores or the
account is removed. For each affected user it advances ``users.change_purge_floor`` to the highest
cursor it removed; that durable watermark is what :class:`atlas.changes.service.ChangesService`
uses to answer ``resync_required`` for a client that has fallen behind (see
:mod:`atlas.changes.retention`).

The delete and the floor update run in the caller's transaction. A crash therefore either purges
nothing or commits the whole bounded batch, so the purge is restart-safe; re-running with the same
cutoff removes nothing and leaves the floor unchanged, so it is idempotent. The durable job that
schedules it lives in :mod:`atlas.jobs.handlers`.

Purging removes a **prefix** of the cursor order: because ``seq`` and ``changed_at`` are stamped
together (ADR-0032), every row with a cursor below the highest removed cursor is itself older than
the cutoff and is removed too. That is what makes ``change_purge_floor`` exact — a client at or
above the floor is guaranteed to still see every change after it.
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
        """Remove ``change_log`` rows with ``changed_at < cutoff`` and advance the floors.

        Only ``change_log`` is deleted — never a task, project or note row. The floor for each user
        is raised to the highest cursor that was removed, and never lowered, so it is monotonic and
        a repeated pass is a no-op.
        """
        removed = (
            await self.session.execute(
                delete(ChangeLog)
                .where(ChangeLog.changed_at < cutoff)
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
