"""Transactional calendar sync over the projection store (M5-06).

This is the Stage-A/B read sync (``CALENDAR_SYNC.md`` §3, ``ARCHITECTURE.md`` §6.3): given a
provider-neutral :class:`~atlas.calendar.adapter.CalendarAdapter` (the real Google/Microsoft ones
are M5-03/M5-04; tests pass the :class:`~atlas.calendar.fake.FakeCalendarAdapter`) and the user's
stored cursor, it pulls the changed events, applies them to the projection store and advances the
cursor.

**Cursor safety is the whole point.** ``CALENDAR_SYNC.md`` §4 and AGENTS.md §10 make it
non-negotiable that a cursor advances only after the changes it covers have been committed and never
in a way that can permanently skip unprocessed changes. The service therefore:

1. reads the stored cursor;
2. drains **every page** of one pass from the adapter, keeping the events, the tombstones and the
   durable ``next_cursor`` (which the contract emits only on the final page);
3. applies the whole change set **and** advances the cursor inside **one transaction**, then
   commits once. If anything raises anywhere between applying and committing, the transaction is
   rolled back, so the cursor is unchanged and a re-sync re-fetches exactly the same changes —
   nothing is skipped. A change that arrives *during* paging is deferred by the adapter's own
   cursor semantics (the returned cursor is the revision the pass started at), so it is picked up
   by the next pass.

The service is strictly user-scoped: every query filters on the caller's ``user_id``. The projection
is Atlas-side only — a provider deletion becomes a **tombstone**, never a delete of the user's data.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import Insert
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import ExternalEvent, SyncCursor
from .adapter import CalendarAdapter, canonical_provider
from .projection import ProjectionState, event_is_unchanged, merge_event_row
from .types import CursorType, Event, EventDeletion

#: The longest failure message recorded on a cursor row (diagnostic only, never event contents).
MAX_ERROR_LENGTH = 500


@dataclass(frozen=True, slots=True)
class ApplyResult:
    """The outcome of applying one pass's changes to the projection store."""

    created: int = 0
    updated: int = 0
    unchanged: int = 0
    tombstoned: int = 0


@dataclass(frozen=True, slots=True)
class SyncResult:
    """The observable outcome of one sync pass (also the data M5-08 will surface)."""

    provider: str
    calendar_id: str
    pages: int
    events_seen: int
    deletions_seen: int
    created: int
    updated: int
    unchanged: int
    tombstoned: int
    cursor_before: str | None
    cursor_after: str | None


def _default_now() -> datetime:
    return datetime.now(UTC)


def _cursor_type_value(cursor_type: CursorType | str) -> str:
    return str(getattr(cursor_type, "value", cursor_type))


def _error_message(exc: BaseException) -> str:
    """A bounded, diagnostic failure message. Provider errors are already content-free."""
    text = str(exc) or exc.__class__.__name__
    return text[:MAX_ERROR_LENGTH]


class CalendarSyncService:
    """Pulls provider changes into the projection store, advancing the cursor only after commit."""

    def __init__(
        self,
        session: AsyncSession,
        user_id: uuid.UUID,
        *,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self.session = session
        self.user_id = user_id
        self._now = now or _default_now

    async def sync_calendar(
        self,
        adapter: CalendarAdapter,
        calendar_id: str,
        *,
        page_size: int | None = None,
    ) -> SyncResult:
        """Pull and apply one calendar's changes, advancing the cursor only on success.

        The whole pass is one unit of work: the projections and the cursor commit together, or not
        at all. On failure the cursor is left exactly where it was (the error is recorded separately
        for sync status) and the caller may retry — a retry re-applies the same changes.
        """
        provider = canonical_provider(adapter.provider)
        cursor_row = await self._load_cursor(provider, calendar_id)
        cursor_before = cursor_row.cursor_value if cursor_row is not None else None

        try:
            events, deletions, next_cursor, pages = await self._fetch(
                adapter, calendar_id, cursor_before, page_size
            )
        except Exception as exc:  # provider failure: nothing was applied, cursor stays put
            await self._record_failure(provider, calendar_id, adapter.cursor_type, exc)
            raise

        now = self._now()
        try:
            applied = await self._apply(provider, events, deletions, now)
            await self._advance_cursor(provider, calendar_id, adapter.cursor_type, next_cursor, now)
            await self.session.commit()
        except Exception as exc:
            # Apply and cursor advance share the transaction; rolling back leaves the cursor
            # unchanged so the changes are re-fetched next pass rather than skipped.
            await self.session.rollback()
            await self._record_failure(provider, calendar_id, adapter.cursor_type, exc)
            raise

        return SyncResult(
            provider=provider,
            calendar_id=calendar_id,
            pages=pages,
            events_seen=len(events),
            deletions_seen=len(deletions),
            created=applied.created,
            updated=applied.updated,
            unchanged=applied.unchanged,
            tombstoned=applied.tombstoned,
            cursor_before=cursor_before,
            cursor_after=next_cursor,
        )

    # --- reading ----------------------------------------------------------------

    async def _fetch(
        self,
        adapter: CalendarAdapter,
        calendar_id: str,
        cursor: str | None,
        page_size: int | None,
    ) -> tuple[list[Event], list[EventDeletion], str | None, int]:
        """Drain every page of one pass; return events, tombstones, the final cursor and page count.

        The same ``cursor`` is carried across pages (the contract's contract) and the durable
        ``next_cursor`` is taken from the **final** page only — an intermediate page never yields a
        cursor worth persisting.
        """
        events: list[Event] = []
        deletions: list[EventDeletion] = []
        page_token: str | None = None
        pages = 0
        while True:
            page = await adapter.list_events(
                calendar_id, cursor=cursor, page_token=page_token, page_size=page_size
            )
            pages += 1
            events.extend(page.events)
            deletions.extend(page.deletions)
            if page.has_more:
                page_token = page.next_page_token
                continue
            return events, deletions, page.next_cursor, pages

    # --- writing ----------------------------------------------------------------

    async def _apply(
        self,
        provider: str,
        events: Sequence[Event],
        deletions: Sequence[EventDeletion],
        now: datetime,
    ) -> ApplyResult:
        """Upsert the changed events and tombstone the deletions (no commit here).

        Events are upserted on the ``(user, provider, external_event_id)`` unique key, so applying
        the same change twice can never create a duplicate projection; an event already at the same
        provider version is left untouched. Deletions mark an **existing** projection ``deleted_at``
        — a deletion for an event that was never projected is a no-op (there is no local data to
        lose), and Atlas never hard-deletes.
        """
        created = updated = unchanged = 0
        if events:
            existing = await self._existing_states(provider, [event.id for event in events])
            rows: list[dict[str, object]] = []
            for event in events:
                state = existing.get(event.id)
                if event_is_unchanged(state, event):
                    unchanged += 1
                    continue
                rows.append(merge_event_row(event, user_id=self.user_id, last_synced_at=now))
                if state is None:
                    created += 1
                else:
                    updated += 1
            if rows:
                await self.session.execute(self._upsert_events_statement(), rows)

        tombstoned = 0
        for deletion in deletions:
            result = await self.session.execute(
                update(ExternalEvent)
                .where(
                    ExternalEvent.user_id == self.user_id,
                    ExternalEvent.provider == provider,
                    ExternalEvent.external_event_id == deletion.id,
                    ExternalEvent.deleted_at.is_(None),
                )
                .values(deleted_at=now, last_synced_at=now)
            )
            tombstoned += int(getattr(result, "rowcount", 0) or 0)

        return ApplyResult(
            created=created, updated=updated, unchanged=unchanged, tombstoned=tombstoned
        )

    @staticmethod
    def _upsert_events_statement() -> Insert:
        """The ``INSERT … ON CONFLICT DO UPDATE`` used to project events idempotently."""
        base = pg_insert(ExternalEvent)
        return base.on_conflict_do_update(
            constraint="uq_external_events_user_provider_external_event_id",
            set_={
                "calendar_id": base.excluded.calendar_id,
                "summary": base.excluded.summary,
                "start_at": base.excluded.start_at,
                "end_at": base.excluded.end_at,
                "time_zone": base.excluded.time_zone,
                "is_all_day": base.excluded.is_all_day,
                "status": base.excluded.status,
                "etag": base.excluded.etag,
                "ical_uid": base.excluded.ical_uid,
                "recurrence_id": base.excluded.recurrence_id,
                "recurrence_rule": base.excluded.recurrence_rule,
                "source_updated_at": base.excluded.source_updated_at,
                "last_synced_at": base.excluded.last_synced_at,
                "deleted_at": None,
                "updated_at": func.now(),
            },
        )

    async def _existing_states(
        self, provider: str, event_ids: Sequence[str]
    ) -> dict[str, ProjectionState]:
        """The stored projection state for the given event ids, in one query (no N+1)."""
        if not event_ids:
            return {}
        rows = (
            await self.session.execute(
                select(
                    ExternalEvent.external_event_id,
                    ExternalEvent.etag,
                    ExternalEvent.source_updated_at,
                    ExternalEvent.deleted_at,
                ).where(
                    ExternalEvent.user_id == self.user_id,
                    ExternalEvent.provider == provider,
                    ExternalEvent.external_event_id.in_(list(event_ids)),
                )
            )
        ).all()
        return {
            row.external_event_id: ProjectionState(
                etag=row.etag,
                source_updated_at=row.source_updated_at,
                deleted_at=row.deleted_at,
            )
            for row in rows
        }

    async def _advance_cursor(
        self,
        provider: str,
        calendar_id: str,
        cursor_type: CursorType | str,
        next_cursor: str | None,
        now: datetime,
    ) -> None:
        """Upsert the cursor row: record success and, when the adapter produced one, the new value.

        When the final page carried no ``next_cursor`` the stored value is **left as it was** —
        the service never invents a cursor. ``last_success_at``/error are refreshed either way. This
        runs in the same transaction as :meth:`_apply`, so the value is committed only with its
        changes.
        """
        values: dict[str, object] = {
            "id": uuid.uuid4(),
            "user_id": self.user_id,
            "provider": provider,
            "calendar_id": calendar_id,
            "cursor_type": _cursor_type_value(cursor_type),
            "last_success_at": now,
            "last_error": None,
            "last_error_at": None,
        }
        set_: dict[str, object] = {
            "cursor_type": _cursor_type_value(cursor_type),
            "last_success_at": now,
            "last_error": None,
            "last_error_at": None,
            "updated_at": func.now(),
        }
        if next_cursor is not None:
            values["cursor_value"] = next_cursor
            set_["cursor_value"] = next_cursor
        statement = (
            pg_insert(SyncCursor)
            .values(**values)
            .on_conflict_do_update(
                constraint="uq_sync_cursors_user_provider_calendar",
                set_=set_,
            )
        )
        await self.session.execute(statement)

    async def _record_failure(
        self,
        provider: str,
        calendar_id: str,
        cursor_type: CursorType | str,
        exc: BaseException,
    ) -> None:
        """Record the failure on the cursor row in its **own** transaction, for sync status.

        This is deliberately separate from the sync transaction and never touches
        ``cursor_value``/``last_success_at``: recording an error must not advance (or rewind) the
        cursor. It must also never mask the original failure, so any error here is swallowed after
        a rollback.
        """
        message = _error_message(exc)
        try:
            await self.session.rollback()
            now = self._now()
            row = await self._load_cursor(provider, calendar_id)
            if row is None:
                self.session.add(
                    SyncCursor(
                        user_id=self.user_id,
                        provider=provider,
                        calendar_id=calendar_id,
                        cursor_type=_cursor_type_value(cursor_type),
                        last_error=message,
                        last_error_at=now,
                    )
                )
            else:
                row.last_error = message
                row.last_error_at = now
            await self.session.commit()
        except Exception:  # pragma: no cover - diagnostic best effort, never masks the real error
            await self.session.rollback()

    async def _load_cursor(self, provider: str, calendar_id: str) -> SyncCursor | None:
        """The caller's cursor row for one ``(provider, calendar)``, or ``None`` on a first sync."""
        row: SyncCursor | None = await self.session.scalar(
            select(SyncCursor)
            .where(
                SyncCursor.user_id == self.user_id,
                SyncCursor.provider == provider,
                SyncCursor.calendar_id == calendar_id,
            )
            .execution_options(populate_existing=True)
        )
        return row
