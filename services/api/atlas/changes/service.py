"""Reading the per-user change feed (M7-01).

The SQL lives here; the pure ordering/validation rules live in :mod:`atlas.changes.feed`. The query
is strictly user-scoped and read-only, and returns one page of changes ordered by the monotonic
per-user cursor.
"""

from __future__ import annotations

import uuid
from dataclasses import replace

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import ChangeLog, User
from .data import load_entity_data
from .feed import ChangeSet, FeedChange, merge_latest, plan_change_page
from .retention import resync_reason


class ChangesService:
    """The caller's change feed, read from ``change_log``."""

    def __init__(self, session: AsyncSession, user_id: uuid.UUID) -> None:
        self.session = session
        self.user_id = user_id

    async def changes(
        self,
        *,
        since: int,
        limit: int,
        types: frozenset[str] | None = None,
        include_data: bool = False,
        snapshot: bool = False,
    ) -> ChangeSet:
        """One page of the caller's changes after ``since``, ordered by cursor ascending.

        Returns the changes with ``seq > since`` (at most ``limit``), the new high-water mark
        ``next_since`` and whether more remains. ``since`` is exactly the previous page's
        ``next_since``, so paging covers the whole change set once: no change is skipped and none is
        repeated. A twice-changed entity appears once, at its latest cursor.

        A ``since`` that predates the retention floor cannot be served incrementally — the changes
        in ``(since, floor]`` were purged — so the result is a **resync signal**: no changes, and
        ``resync_required=True`` with ``next_since`` at the current high-water mark (M7-02).
        Returning a partial set could let the client resurrect a purged delete. A ``since`` *above*
        the head (the server was restored from an older backup, or is another server) is a resync
        signal too, with ``resync_reason="cursor_ahead"`` (SYNC-01): an empty page there would make
        the client believe it is current while the server lacks changes the client holds.

        The change store keeps a single row per entity, but :func:`merge_latest` collapses any
        duplicates defensively — so the ``limit + 1`` fetch bound is exact and ``has_more`` honest.

        SYNC-03e (SYNC_PROTOCOL.md section 4): ``since == 0`` is a **snapshot** - every live entity
        and no tombstone of the first page (a client with no state has nothing to delete; later
        pages carry deletions that happened during the walk); ``types`` restricts the entity types
        while the cursor still advances over the filtered-out rows (the last page reports the head
        as ``next_since``); ``snapshot`` marks a continuation page of a snapshot walk (never below
        the floor); ``include_data`` adds each entity's revision and stored state. The page
        never reaches past the ``head`` read at its start, so a row committed meanwhile is
        delivered by the next page, never skipped.
        """
        floor, head = await self._feed_bounds()
        reason = resync_reason(since, floor, head, snapshot=snapshot)
        if reason is not None:
            return ChangeSet(
                changes=[],
                next_since=max(head, floor),
                has_more=False,
                resync_required=True,
                resync_reason=reason,
                head=head,
                floor=floor,
            )
        stmt = select(ChangeLog).where(
            ChangeLog.user_id == self.user_id, ChangeLog.seq > since, ChangeLog.seq <= head
        )
        if since == 0:
            stmt = stmt.where(ChangeLog.operation == "upsert")
        if types:
            stmt = stmt.where(ChangeLog.entity_type.in_(sorted(types)))
        rows = list(await self.session.scalars(stmt.order_by(ChangeLog.seq.asc()).limit(limit + 1)))
        merged = merge_latest(
            [
                FeedChange(
                    entity_type=row.entity_type,
                    entity_id=row.entity_id,
                    operation=row.operation,
                    cursor=row.seq,
                    changed_at=row.changed_at,
                )
                for row in rows
            ]
        )
        plan = plan_change_page([change.cursor for change in merged], since=since, limit=limit)
        delivered = merged[: plan.deliver]
        if include_data:
            delivered = await self._with_data(delivered)
        # Nothing left: everything up to ``head`` has been considered, including rows a filter
        # skipped, so the client's cursor may move there.
        next_since = plan.next_since if plan.has_more else max(plan.next_since, head)
        return ChangeSet(
            changes=delivered,
            next_since=next_since,
            has_more=plan.has_more,
            resync_required=False,
            head=head,
            floor=floor,
        )

    async def _with_data(self, changes: list[FeedChange]) -> list[FeedChange]:
        wanted: dict[str, list[str]] = {}
        for change in changes:
            wanted.setdefault(change.entity_type, []).append(change.entity_id)
        loaded = await load_entity_data(self.session, self.user_id, wanted)
        enriched: list[FeedChange] = []
        for change in changes:
            found = loaded.get((change.entity_type, change.entity_id))
            enriched.append(
                replace(change, revision=found[0], data=found[1]) if found is not None else change
            )
        return enriched

    async def _feed_bounds(self) -> tuple[int, int]:
        """Return ``(purge_floor, high_water)`` for the caller: the retained cursor range.

        ``purge_floor`` (``users.change_purge_floor``) is the highest cursor the purge has removed;
        everything above it is still retained. ``high_water`` (``users.change_seq``) is the last
        cursor allocated — the feed's head, and the cursor a client resumes from after a full
        resync.
        """
        row = (
            await self.session.execute(
                select(User.change_purge_floor, User.change_seq).where(User.id == self.user_id)
            )
        ).one_or_none()
        if row is None:
            return 0, 0
        return int(row[0]), int(row[1])
