"""The unified, read-only event view (M5-07, ADR-0071).

Reads the projection (``external_events``) for the user's **selected** calendars and returns the
occurrences that overlap a bounded window:

- single events and provider-expanded occurrences (Graph) come straight from the rows;
- a recurring **master** (Google/ICS ``recurrence_rule``) is expanded for the window with
  :func:`atlas.calendar.recurrence.expand_series`; an occurrence is dropped when an override or a
  cancelled override exists for the same original start (:attr:`ExternalEvent.recurrence_id`);
- overrides whose master was deleted at the provider are hidden; cancelled events never appear.

Instants are UTC. Each item also carries the event's own IANA ``time_zone`` and, for all-day events,
the local ``start_date``/``end_date`` (end exclusive) so a client shows the *same date* in every
viewer zone. Provider ids never leave the server: items are addressed by the projection row's UUID
(plus ``occurrence`` for an expanded instance).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import and_, or_, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import CalendarSource, ExternalEvent
from .recurrence import expand_series, local_dates, occurrence_key
from .types import EventStatus

MAX_WINDOW = timedelta(days=100)
DEFAULT_LIMIT = 500
MAX_LIMIT = 1000


class WindowError(ValueError):
    """The requested window is empty, inverted or too large."""


@dataclass(frozen=True, slots=True)
class EventItem:
    id: uuid.UUID
    occurrence: str | None
    source_id: uuid.UUID
    provider: str
    title: str | None
    start: datetime
    end: datetime
    time_zone: str
    is_all_day: bool
    start_date: date | None
    end_date: date | None
    status: str
    is_recurring: bool
    location: str | None
    description: str | None
    web_link: str | None
    row: ExternalEvent


@dataclass(frozen=True, slots=True)
class EventWindow:
    items: tuple[EventItem, ...]
    total: int
    truncated: bool


def check_window(start: datetime, end: datetime) -> None:
    if start.tzinfo is None or end.tzinfo is None:
        raise WindowError("start and end must carry a UTC offset")
    if end <= start:
        raise WindowError("end must be after start")
    if end - start > MAX_WINDOW:
        raise WindowError(f"the window may span at most {MAX_WINDOW.days} days")


def _item(
    row: ExternalEvent,
    source: CalendarSource,
    start: datetime,
    end: datetime,
    occurrence: str | None,
) -> EventItem:
    first = last = None
    if row.is_all_day:
        first, last = local_dates(start, end, row.time_zone)
    return EventItem(
        id=row.id,
        occurrence=occurrence,
        source_id=source.id,
        provider=row.provider,
        title=row.summary,
        start=start,
        end=end,
        time_zone=row.time_zone,
        is_all_day=row.is_all_day,
        start_date=first,
        end_date=last,
        status=row.status,
        is_recurring=bool(row.recurrence_rule) or row.series_id is not None,
        location=row.location,
        description=row.description,
        web_link=row.web_link,
        row=row,
    )


class EventQueryService:
    def __init__(self, session: AsyncSession, user_id: uuid.UUID) -> None:
        self.session = session
        self.user_id = user_id

    async def _selected_sources(self) -> dict[tuple[str, str], CalendarSource]:
        rows = await self.session.scalars(
            select(CalendarSource).where(
                CalendarSource.user_id == self.user_id, CalendarSource.selected.is_(True)
            )
        )
        return {(row.provider, row.external_id): row for row in rows}

    async def window(
        self,
        start: datetime,
        end: datetime,
        *,
        limit: int = DEFAULT_LIMIT,
        offset: int = 0,
    ) -> EventWindow:
        check_window(start, end)
        start, end = start.astimezone(UTC), end.astimezone(UTC)
        sources = await self._selected_sources()
        if not sources:
            return EventWindow((), 0, False)
        keys = list(sources)
        scope = tuple_(ExternalEvent.provider, ExternalEvent.calendar_id).in_(keys)
        base = (ExternalEvent.user_id == self.user_id, ExternalEvent.deleted_at.is_(None), scope)

        single = await self.session.scalars(
            select(ExternalEvent).where(
                *base,
                ExternalEvent.recurrence_rule.is_(None),
                ExternalEvent.status != EventStatus.CANCELLED.value,
                or_(
                    and_(ExternalEvent.start_at < end, ExternalEvent.end_at > start),
                    and_(ExternalEvent.start_at >= start, ExternalEvent.start_at < end),
                ),
            )
        )
        singles = [*single]
        masters = [
            *await self.session.scalars(
                select(ExternalEvent).where(
                    *base,
                    ExternalEvent.recurrence_rule.is_not(None),
                    ExternalEvent.status != EventStatus.CANCELLED.value,
                    ExternalEvent.start_at < end,
                )
            )
        ]

        suppressed: set[tuple[str, str]] = set()
        if masters:
            overrides = await self.session.execute(
                select(ExternalEvent.series_id, ExternalEvent.recurrence_id).where(
                    *base,
                    ExternalEvent.series_id.in_([m.external_event_id for m in masters]),
                    ExternalEvent.recurrence_id.is_not(None),
                )
            )
            suppressed = {(s, r) for s, r in overrides.all() if s and r}

        orphaned = await self._tombstoned_masters(singles)

        items: list[EventItem] = []
        for row in singles:
            if row.series_id in orphaned and row.recurrence_id is not None:
                continue
            items.append(
                _item(row, sources[(row.provider, row.calendar_id)], row.start_at, row.end_at, None)
            )
        for master in masters:
            source = sources[(master.provider, master.calendar_id)]
            for occ_start, occ_end in expand_series(
                start=master.start_at,
                end=master.end_at,
                zone_name=master.time_zone,
                is_all_day=master.is_all_day,
                rules_text=master.recurrence_rule,
                window_start=start,
                window_end=end,
            ):
                key = occurrence_key(occ_start)
                if (master.external_event_id, key) in suppressed:
                    continue
                items.append(_item(master, source, occ_start, occ_end, key))

        items.sort(key=lambda i: (i.start, i.end, str(i.id), i.occurrence or ""))
        total = len(items)
        page = items[offset : offset + limit]
        return EventWindow(tuple(page), total, offset + limit < total)

    async def _tombstoned_masters(self, rows: list[ExternalEvent]) -> set[str]:
        """Series ids (of override rows) whose master exists but was deleted or cancelled."""
        ids = {r.series_id for r in rows if r.series_id and r.recurrence_id is not None}
        if not ids:
            return set()
        gone = await self.session.scalars(
            select(ExternalEvent.external_event_id).where(
                ExternalEvent.user_id == self.user_id,
                ExternalEvent.external_event_id.in_(ids),
                or_(
                    ExternalEvent.deleted_at.is_not(None),
                    ExternalEvent.status == EventStatus.CANCELLED.value,
                ),
            )
        )
        return set(gone)

    async def detail(self, event_id: uuid.UUID, occurrence: str | None = None) -> EventItem | None:
        """One event (or one occurrence of a series) the user can see, else ``None``."""
        row = await self.session.scalar(
            select(ExternalEvent).where(
                ExternalEvent.id == event_id,
                ExternalEvent.user_id == self.user_id,
                ExternalEvent.deleted_at.is_(None),
            )
        )
        if row is None or row.status == EventStatus.CANCELLED.value:
            return None
        source = (await self._selected_sources()).get((row.provider, row.calendar_id))
        if source is None:
            return None
        if row.recurrence_rule is None:
            return _item(row, source, row.start_at, row.end_at, None)
        if occurrence is None:
            return _item(row, source, row.start_at, row.end_at, occurrence_key(row.start_at))
        try:
            wanted = datetime.strptime(occurrence, "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)
        except ValueError:
            return None
        for occ_start, occ_end in expand_series(
            start=row.start_at,
            end=row.end_at,
            zone_name=row.time_zone,
            is_all_day=row.is_all_day,
            rules_text=row.recurrence_rule,
            window_start=wanted - timedelta(seconds=1),
            window_end=wanted + timedelta(seconds=1),
        ):
            if occurrence_key(occ_start) == occurrence:
                return _item(row, source, occ_start, occ_end, occurrence)
        return None
