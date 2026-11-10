"""Provider-neutral calendar data types (M5-02).

The synchronisation layer works entirely with these shapes. **No Google Calendar or Microsoft
Graph type (or SDK object) crosses the adapter boundary** (AGENTS.md §7.3, ARCHITECTURE §4): an
adapter translates provider payloads *into* these types and translates provider failures into the
taxonomy in :mod:`atlas.calendar.errors`.

Time handling (DATA_MODEL.md §4): every instant is **timezone-aware** (stored as UTC) and the IANA
``time_zone`` is carried alongside it, so a wall-clock interpretation (all-day events, recurrence
expansion) can still be recovered. For an all-day event ``start``/``end`` are the local day
boundaries expressed as instants.

Cursors and pagination are deliberately separate concepts:

- a **page token** walks the pages of one listing call (transient, provider-defined);
- a **cursor** is the durable incremental-sync token (Google ``syncToken``, Microsoft ``deltaLink``)
  that the sync layer persists *only after* the corresponding changes are committed
  (CALENDAR_SYNC §4). :class:`EventPage.next_cursor` is therefore populated only on the final page.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum


class EventStatus(StrEnum):
    """The provider-neutral lifecycle state of an event.

    Maps from Google's ``status`` and Microsoft's ``isCancelled``/tentative signals. ``CANCELLED``
    means the provider still returns the event but marks it cancelled; a provider that removes an
    event entirely is represented by an :class:`EventDeletion` instead.
    """

    CONFIRMED = "confirmed"
    TENTATIVE = "tentative"
    CANCELLED = "cancelled"


class CursorType(StrEnum):
    """The kind of durable incremental cursor a provider issues (DATA_MODEL.md §2.4 ``SyncCursor``).

    The adapter declares which kind it produces; the sync layer persists the opaque value against
    that type without interpreting it.
    """

    SYNC_TOKEN = "sync_token"
    DELTA_LINK = "delta_link"
    HISTORY_ID = "history_id"
    #: A feed with no incremental API (ICS): the cursor is the HTTP validator (ETag/Last-Modified)
    #: of the last snapshot that was applied, used only for a conditional GET.
    FEED_VALIDATOR = "feed_validator"


def _require_text(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty string")
    return value


def _require_aware(value: object, field: str) -> datetime:
    if not isinstance(value, datetime):
        raise ValueError(f"{field} must be a datetime")
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{field} must be timezone-aware")
    return value


@dataclass(frozen=True, slots=True)
class Calendar:
    """A calendar the provider exposes for an account (maps to ``CalendarSource``).

    ``id`` is the **provider's** calendar identifier; Atlas derives its own stable UUID separately.
    ``is_read_only`` reflects provider permissions (the sync layer must not attempt writes to it).
    """

    id: str
    provider: str
    name: str
    time_zone: str
    is_read_only: bool = False
    is_primary: bool = False
    color: str | None = None

    def __post_init__(self) -> None:
        _require_text(self.id, "id")
        _require_text(self.provider, "provider")
        _require_text(self.name, "name")
        _require_text(self.time_zone, "time_zone")


@dataclass(frozen=True, slots=True)
class Event:
    """A provider-neutral event (maps to the ``ExternalEvent`` projection).

    Required identity/version fields: ``id`` (provider event id), ``calendar_id``, ``provider``,
    ``start``/``end`` (aware instants), ``time_zone`` (IANA) and ``updated`` (provider last-modified
    instant). ``etag`` is the provider's opaque version/concurrency token (Google ``etag``,
    Microsoft ``changeKey``) and is what conflict detection uses (CALENDAR_SYNC §6). For an instance
    of a recurring series, ``recurrence_id`` identifies the instance and ``recurrence_rule`` carries
    the projected RFC 5545 rule.
    """

    id: str
    calendar_id: str
    provider: str
    summary: str | None
    start: datetime
    end: datetime
    time_zone: str
    updated: datetime
    is_all_day: bool = False
    status: EventStatus = EventStatus.CONFIRMED
    etag: str | None = None
    recurrence_id: str | None = None
    recurrence_rule: str | None = None
    ical_uid: str | None = None
    #: Display-only detail (bounded by the adapter): never used for identity or conflict checks.
    location: str | None = None
    description: str | None = None
    web_link: str | None = None
    #: For an exception/override of a recurring series: the master event's ``id``.
    series_id: str | None = None

    def __post_init__(self) -> None:
        _require_text(self.id, "id")
        _require_text(self.calendar_id, "calendar_id")
        _require_text(self.provider, "provider")
        _require_text(self.time_zone, "time_zone")
        _require_aware(self.start, "start")
        _require_aware(self.end, "end")
        _require_aware(self.updated, "updated")
        if self.end < self.start:
            raise ValueError("end must not be before start")
        if not isinstance(self.status, EventStatus):
            raise ValueError("status must be an EventStatus")


@dataclass(frozen=True, slots=True)
class EventDeletion:
    """A tombstone: an event the provider no longer returns (maps to a ``deleted_at`` projection).

    Surfaced explicitly so the sync layer can remove/mark the local projection **without** treating
    a short page as "everything else is gone" (DATA_MODEL.md §5, CALENDAR_SYNC §3). For a cancelled
    occurrence of a series, ``recurrence_id`` identifies which instance was removed.
    """

    id: str
    calendar_id: str
    provider: str
    recurrence_id: str | None = None
    deleted_at: datetime | None = None

    def __post_init__(self) -> None:
        _require_text(self.id, "id")
        _require_text(self.calendar_id, "calendar_id")
        _require_text(self.provider, "provider")
        if self.deleted_at is not None:
            _require_aware(self.deleted_at, "deleted_at")


@dataclass(frozen=True, slots=True)
class EventPage:
    """One page of a listing call: changed events, tombstones and the continuation handles.

    ``next_page_token`` is set while more pages remain for this call (``has_more`` is ``True``);
    ``next_cursor`` is set **only on the final page** and is the durable cursor the sync layer may
    persist once every change in the call has been committed. A page with neither handle is the end
    of a listing that produced no incremental cursor.
    """

    events: tuple[Event, ...] = ()
    deletions: tuple[EventDeletion, ...] = ()
    next_page_token: str | None = None
    next_cursor: str | None = None
    #: ``True`` on the final page of a listing that enumerated **every** live event of the calendar
    #: (an initial/full sync, a resync after ``410 Gone``, or a whole ICS feed). The sync layer then
    #: tombstones projections the listing did not contain. It is set only by an adapter that has
    #: read the complete listing without error: a failed or partial read never sets it.
    is_snapshot: bool = False

    @property
    def has_more(self) -> bool:
        """Whether the caller must request another page with :attr:`next_page_token`."""
        return self.next_page_token is not None
