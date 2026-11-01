"""In-memory fake calendar adapter (M5-02).

A deterministic implementation of :class:`~atlas.calendar.adapter.CalendarAdapter` that never
contacts a network. It is used by the M5-02 contract tests and is intended to be reused by the M5-06
projection-store / sync tests (registered through an
:class:`~atlas.calendar.adapter.AdapterRegistry` via :func:`fake_adapter_factory`).

It models the provider behaviours the sync layer must survive:

- **Pagination** — ``page_size`` bounds each page and ``next_page_token`` walks one listing pass
  without gaps or duplicates.
- **Incremental cursors** — every mutation advances an internal revision. A cursor (``"rev:<n>"``)
  returns only the events changed *after* ``n``. The cursor echoed on the final page is the revision
  the pass was taken at, so a change made while the caller pages is returned by the *next* pass and
  can never be skipped (CALENDAR_SYNC §4).
- **Deletions/tombstones** — :meth:`delete_event` records a tombstone that is surfaced through
  :attr:`atlas.calendar.types.EventPage.deletions`.

The seeding/mutation helpers (:meth:`add_calendar`, :meth:`add_event`, :meth:`update_event`,
:meth:`delete_event`) are **not** part of the contract; the sync layer never calls them.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime

from .adapter import AdapterFactory, CalendarAdapter
from .tokens import StoredCredential
from .types import Calendar, CursorType, Event, EventDeletion, EventPage

_CURSOR_PREFIX = "rev:"
#: Default page size; a small reading of a realistic provider default.
DEFAULT_PAGE_SIZE = 100


@dataclass(frozen=True, slots=True)
class _Change:
    """One entry in the fake's append-only change log."""

    revision: int
    calendar_id: str
    event_id: str
    item: Event | EventDeletion


def _start_key(event: Event) -> tuple[datetime, str]:
    """Order full-sync events by start instant, then id (a stable, deterministic order)."""
    return (event.start, event.id)


class FakeCalendarAdapter:
    """An in-memory :class:`CalendarAdapter` with paging, cursors and tombstones."""

    provider: str
    cursor_type: CursorType = CursorType.SYNC_TOKEN

    def __init__(self, *, provider: str = "fake", page_size: int = DEFAULT_PAGE_SIZE) -> None:
        if page_size <= 0:
            raise ValueError("page_size must be positive")
        self.provider = provider
        self.page_size = page_size
        self._calendars: dict[str, Calendar] = {}
        self._log: list[_Change] = []
        self._revision = 0

    # -- seeding / mutation helpers (not part of the contract) --------------

    def add_calendar(self, calendar: Calendar) -> Calendar:
        """Register a calendar (idempotent by id)."""
        self._calendars[calendar.id] = calendar
        return calendar

    def add_event(self, event: Event) -> Event:
        """Create or replace an event, recording a change at the next revision."""
        return self._record(event)

    def update_event(self, event: Event) -> Event:
        """Replace an event (same bookkeeping as :meth:`add_event`); kept for intent."""
        return self._record(event)

    def delete_event(
        self,
        event_id: str,
        calendar_id: str,
        *,
        recurrence_id: str | None = None,
        deleted_at: datetime | None = None,
    ) -> EventDeletion:
        """Remove an event and record a tombstone for it."""
        deletion = EventDeletion(
            id=event_id,
            calendar_id=calendar_id,
            provider=self.provider,
            recurrence_id=recurrence_id,
            deleted_at=deleted_at,
        )
        self._append(calendar_id, event_id, deletion)
        return deletion

    def current_cursor(self) -> str:
        """The durable cursor that covers every change recorded so far."""
        return self._format_cursor(self._revision)

    # -- the contract -------------------------------------------------------

    async def list_calendars(self) -> list[Calendar]:
        return [self._calendars[calendar_id] for calendar_id in sorted(self._calendars)]

    async def list_events(
        self,
        calendar_id: str,
        *,
        cursor: str | None = None,
        page_token: str | None = None,
        page_size: int | None = None,
    ) -> EventPage:
        if calendar_id not in self._calendars:
            raise ValueError(f"unknown calendar {calendar_id!r}")
        size = self.page_size if page_size is None else page_size
        if size <= 0:
            raise ValueError("page_size must be positive")

        cursor_revision = self._parse_cursor(cursor)
        if page_token is None:
            up_to_revision = self._revision
            offset = 0
        else:
            up_to_revision, offset = self._parse_page_token(page_token)

        items = self._items(calendar_id, cursor_revision, up_to_revision)
        page = items[offset : offset + size]
        has_more = offset + size < len(items)
        return EventPage(
            events=tuple(item for item in page if isinstance(item, Event)),
            deletions=tuple(item for item in page if isinstance(item, EventDeletion)),
            next_page_token=f"{up_to_revision}:{offset + size}" if has_more else None,
            next_cursor=None if has_more else self._format_cursor(up_to_revision),
        )

    # -- internals ----------------------------------------------------------

    def _record(self, event: Event) -> Event:
        self._append(event.calendar_id, event.id, event)
        return event

    def _append(self, calendar_id: str, event_id: str, item: Event | EventDeletion) -> None:
        self._revision += 1
        self._log.append(_Change(self._revision, calendar_id, event_id, item))

    def _items(
        self, calendar_id: str, cursor_revision: int | None, up_to_revision: int
    ) -> Sequence[Event | EventDeletion]:
        """The ordered items for one listing pass.

        Full sync (``cursor_revision is None``) is the live state at ``up_to_revision`` ordered by
        start time. An incremental pass is the *latest* change per event after the cursor, ordered
        by the revision at which it changed — an event touched twice appears once, in final form.
        """
        latest: dict[str, _Change] = {}
        for change in self._log:
            if change.calendar_id != calendar_id or change.revision > up_to_revision:
                continue
            if cursor_revision is not None and change.revision <= cursor_revision:
                continue
            latest[change.event_id] = change

        changes = sorted(latest.values(), key=lambda change: (change.revision, change.event_id))
        if cursor_revision is None:
            live: list[Event] = []
            for change in changes:
                item = change.item
                if isinstance(item, Event):
                    live.append(item)
            ordered: list[Event] = sorted(live, key=_start_key)
            return ordered
        return [change.item for change in changes]

    @staticmethod
    def _format_cursor(revision: int) -> str:
        return f"{_CURSOR_PREFIX}{revision}"

    @staticmethod
    def _parse_cursor(cursor: str | None) -> int | None:
        if cursor is None:
            return None
        if not cursor.startswith(_CURSOR_PREFIX):
            raise ValueError(f"invalid cursor {cursor!r}")
        try:
            return int(cursor[len(_CURSOR_PREFIX) :])
        except ValueError as exc:
            raise ValueError(f"invalid cursor {cursor!r}") from exc

    @staticmethod
    def _parse_page_token(page_token: str) -> tuple[int, int]:
        revision_text, _, offset_text = page_token.partition(":")
        try:
            return int(revision_text), int(offset_text)
        except ValueError as exc:
            raise ValueError(f"invalid page token {page_token!r}") from exc


def fake_adapter_factory(adapter: FakeCalendarAdapter) -> AdapterFactory:
    """An :data:`~atlas.calendar.adapter.AdapterFactory` that always returns ``adapter``.

    The credential is ignored — the fake has no OAuth exchange — which lets a registry be populated
    with the fake exactly as it would be with a real adapter (``registry.register("google", ...)``).
    """

    def factory(credential: StoredCredential) -> CalendarAdapter:
        del credential  # the fake needs no tokens
        return adapter

    return factory
