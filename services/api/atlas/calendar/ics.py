"""RFC 5545 parsing and the ICS feed adapter (M5-11, ADR-0071, ADR-0072).

Parsing uses the maintained **``icalendar``** library (BSD-2-Clause) for the iCalendar grammar and
``zoneinfo``/``dateutil`` for zones and recurrence (:mod:`atlas.calendar.recurrence`); Atlas writes
neither a parser nor a recurrence engine. What this module adds is the mapping to the neutral
:class:`~atlas.calendar.types.Event`:

- ``VEVENT`` -> one event; identity is ``UID`` (a master) or ``UID#RECURRENCE-ID`` (an override), so
  it is stable across polls. A feed edit therefore updates in place and a feed deletion is detected
  by **diffing**: the adapter reports the *complete* feed as a snapshot (``is_snapshot``) and the
  sync
  layer tombstones every projection that is no longer listed.
- ``DTSTART``/``DTEND``/``DURATION``: a ``DATE`` value is an **all-day** event (local dates in the
  feed's zone), a ``Z`` value is UTC, ``TZID`` is resolved to IANA (Windows names mapped; an unknown
  zone falls back to the feed's default zone, which is ``X-WR-TIMEZONE`` or UTC) and floating times
  use
  that default zone.
- ``RRULE``/``EXDATE``/``RDATE`` are normalised to UTC instants and kept on the master
  (``recurrence_rule``); ``RECURRENCE-ID`` overrides and ``STATUS:CANCELLED`` occurrences suppress
  the master's expansion. ``RANGE=THISANDFUTURE`` is not supported (treated as a single override).
- Robustness: a malformed event is skipped and counted, never fatal; a body that is not an
  iCalendar,
  more than :data:`MAX_EVENTS` events or an unusable rule is handled without crashing the sync.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from icalendar import Calendar as ICalendar

from ..config import get_settings
from .feed import FeedError, fetch_feed
from .google import EPOCH, clip
from .ids import event_key
from .recurrence import format_instants, occurrence_key, rule_is_supported
from .timezones import resolve_zone
from .types import Calendar, CursorType, Event, EventPage, EventStatus

ICS = "ics"
MAX_EVENTS = 20_000


@dataclass(frozen=True, slots=True)
class ParsedFeed:
    events: tuple[Event, ...]
    skipped: int
    name: str | None
    time_zone: str


def _first(value: Any) -> Any:
    return value[0] if isinstance(value, list) and value else value


def _prop_text(component: Any, name: str) -> str | None:
    value = _first(component.get(name))
    return str(value) if value is not None else None


def _resolve(value: Any, tzid: str | None, default_zone: str) -> tuple[datetime, bool, str]:
    """``(UTC instant, is_all_day, zone)`` for a parsed DATE or DATE-TIME value."""
    if isinstance(value, datetime):
        if value.tzinfo is None:
            zone = resolve_zone(tzid, default_zone)
            return value.replace(tzinfo=ZoneInfo(zone), fold=0).astimezone(UTC), False, zone
        instant = value.astimezone(UTC)
        zone = (
            resolve_zone(tzid, "UTC")
            if tzid
            else (
                "UTC"
                if instant.utcoffset() is not None and value.utcoffset() == timedelta(0)
                else default_zone
            )
        )
        return instant, False, zone
    if isinstance(value, date):
        zone = default_zone
        midnight = datetime.combine(value, time.min, tzinfo=ZoneInfo(zone)).astimezone(UTC)
        return midnight, True, zone
    raise ValueError("unsupported date value")


def _read_when(component: Any, name: str, default_zone: str) -> tuple[datetime, bool, str] | None:
    prop = _first(component.get(name))
    if prop is None:
        return None
    tzid = prop.params.get("TZID") if hasattr(prop, "params") else None
    return _resolve(prop.dt, str(tzid) if tzid else None, default_zone)


def _date_list(component: Any, name: str, default_zone: str) -> list[datetime]:
    props = component.get(name)
    if props is None:
        return []
    out: list[datetime] = []
    for prop in props if isinstance(props, list) else [props]:
        tzid = prop.params.get("TZID") if hasattr(prop, "params") else None
        for item in getattr(prop, "dts", []):
            try:
                out.append(_resolve(item.dt, str(tzid) if tzid else None, default_zone)[0])
            except (ValueError, TypeError):
                continue
    return out


def _rrule_text(component: Any) -> list[str]:
    value = component.get("RRULE")
    if value is None:
        return []
    rules = value if isinstance(value, list) else [value]
    texts = []
    for rule in rules:
        raw = rule.to_ical().decode("utf-8", "replace")
        if rule_is_supported(raw):
            texts.append(raw)
    return texts


def _content_hash(parts: Sequence[object]) -> str:
    return hashlib.sha256(json.dumps(parts, default=str, sort_keys=True).encode()).hexdigest()[:32]


def _convert(component: Any, *, feed_id: str, default_zone: str) -> Event | None:
    uid = _prop_text(component, "UID")
    start = _read_when(component, "DTSTART", default_zone)
    if not uid or start is None:
        return None
    start_at, all_day, zone = start
    end = _read_when(component, "DTEND", default_zone)
    if end is not None:
        end_at = end[0]
    else:
        duration = _first(component.get("DURATION"))
        if duration is not None:
            end_at = start_at + duration.dt
        elif all_day:
            end_at = datetime.combine(
                start_at.astimezone(ZoneInfo(zone)).date() + timedelta(days=1),
                time.min,
                tzinfo=ZoneInfo(zone),
            ).astimezone(UTC)
        else:
            end_at = start_at
    if end_at < start_at:
        end_at = start_at

    recurrence_prop = _first(component.get("RECURRENCE-ID"))
    recurrence_key: str | None = None
    if recurrence_prop is not None:
        tzid = recurrence_prop.params.get("TZID")
        original, _, _ = _resolve(recurrence_prop.dt, str(tzid) if tzid else None, default_zone)
        recurrence_key = occurrence_key(original)

    rules = _rrule_text(component) if recurrence_key is None else []
    lines = [f"RRULE:{rule}" for rule in rules]
    exdates = (
        _date_list(component, "EXDATE", default_zone) if rules or component.get("RDATE") else []
    )
    rdates = _date_list(component, "RDATE", default_zone) if recurrence_key is None else []
    if rules or rdates:
        if exdates:
            lines.append(format_instants("EXDATE", exdates))
        if rdates:
            lines.append(format_instants("RDATE", rdates))
    rule_text = "\n".join(lines) or None

    status_text = (_prop_text(component, "STATUS") or "").upper()
    status = (
        EventStatus.CANCELLED
        if status_text == "CANCELLED"
        else EventStatus.TENTATIVE
        if status_text == "TENTATIVE"
        else EventStatus.CONFIRMED
    )
    stamp = _first(component.get("LAST-MODIFIED")) or _first(component.get("DTSTAMP"))
    updated = EPOCH
    if stamp is not None and isinstance(getattr(stamp, "dt", None), datetime):
        try:
            updated = stamp.dt.astimezone(UTC) if stamp.dt.tzinfo else stamp.dt.replace(tzinfo=UTC)
        except (ValueError, OverflowError):
            updated = EPOCH

    master_key = event_key(feed_id, uid)
    raw_id = uid if recurrence_key is None else f"{uid}#{recurrence_key}"
    summary = clip(_prop_text(component, "SUMMARY"), 1000)
    location = clip(_prop_text(component, "LOCATION"), 500)
    description = clip(_prop_text(component, "DESCRIPTION"), 4000)
    url = _prop_text(component, "URL")
    web_link = url if url and url.lower().startswith(("https://", "http://")) else None
    etag = _content_hash(
        [
            summary,
            start_at,
            end_at,
            zone,
            all_day,
            rule_text,
            status.value,
            location,
            description,
            recurrence_key,
            _prop_text(component, "SEQUENCE"),
        ]
    )
    return Event(
        id=event_key(feed_id, raw_id),
        calendar_id=feed_id,
        provider=ICS,
        summary=summary,
        start=start_at,
        end=end_at,
        time_zone=zone,
        updated=updated,
        is_all_day=all_day,
        status=status,
        etag=etag,
        recurrence_id=recurrence_key,
        recurrence_rule=rule_text,
        ical_uid=clip(uid, 512),
        location=location,
        description=description,
        web_link=clip(web_link, 1000),
        series_id=master_key if recurrence_key is not None else None,
    )


def parse_ics(body: bytes, *, feed_id: str, fallback_zone: str = "UTC") -> ParsedFeed:
    """Parse a feed body. Raises :class:`FeedError` only when it is not an iCalendar at all."""
    text = body.decode("utf-8-sig", errors="replace")
    if "BEGIN:VCALENDAR" not in text[:4096].upper():
        raise FeedError("not_calendar", "feed is not a calendar (no VCALENDAR found)")
    try:
        calendar = ICalendar.from_ical(text)
    except Exception as exc:  # the library raises many types on malformed input
        raise FeedError("not_calendar", "feed could not be read as a calendar") from exc
    zone = resolve_zone(str(calendar.get("X-WR-TIMEZONE") or ""), fallback_zone)
    name = clip(str(calendar.get("X-WR-CALNAME") or ""), 200)
    events: dict[str, Event] = {}
    skipped = 0
    for component in calendar.walk("VEVENT"):
        if len(events) >= MAX_EVENTS:
            raise FeedError("too_large", "feed has too many events")
        try:
            event = _convert(component, feed_id=feed_id, default_zone=zone)
        except Exception:  # one bad event never fails the feed
            event = None
        if event is None:
            skipped += 1
            continue
        events[event.id] = event
    return ParsedFeed(tuple(events.values()), skipped, name, zone)


def _decode_cursor(cursor: str | None) -> dict[str, str]:
    if not cursor:
        return {}
    try:
        data = json.loads(cursor)
    except ValueError:
        return {}
    return {k: v for k, v in data.items() if isinstance(v, str)} if isinstance(data, dict) else {}


class IcsFeedAdapter:
    """:class:`~atlas.calendar.adapter.CalendarAdapter` over one secret ICS feed URL."""

    provider = ICS
    cursor_type = CursorType.FEED_VALIDATOR

    def __init__(self, *, feed_id: str, url: str, name: str, time_zone: str = "UTC") -> None:
        self._feed_id = feed_id
        self._url = url
        self._name = name
        self._zone = time_zone
        self.last_skipped = 0

    def __repr__(self) -> str:  # the URL is a secret: never in a repr, a log or a traceback
        return f"IcsFeedAdapter(feed_id={self._feed_id!r})"

    async def list_calendars(self) -> Sequence[Calendar]:
        return [
            Calendar(
                id=self._feed_id,
                provider=ICS,
                name=self._name,
                time_zone=self._zone,
                is_read_only=True,
            )
        ]

    async def list_events(
        self,
        calendar_id: str,
        *,
        cursor: str | None = None,
        page_token: str | None = None,
        page_size: int | None = None,
    ) -> EventPage:
        validators = _decode_cursor(cursor)
        result = await fetch_feed(
            self._url, etag=validators.get("etag"), last_modified=validators.get("lm")
        )
        if result.not_modified:
            return EventPage(next_cursor=cursor)
        digest = hashlib.sha256(result.body).hexdigest()
        parsed = parse_ics(result.body, feed_id=self._feed_id, fallback_zone=self._zone)
        self.last_skipped = parsed.skipped
        stored: dict[str, str] = {"sha": digest}
        if result.etag:
            stored["etag"] = result.etag
        if result.last_modified:
            stored["lm"] = result.last_modified
        return EventPage(
            events=parsed.events,
            next_cursor=json.dumps(stored, separators=(",", ":"), sort_keys=True),
            is_snapshot=True,
        )


async def preview_feed(url: str) -> tuple[int, str | None, int]:
    """``(event count, calendar name, skipped)`` for the add-feed "test" step. Nothing is stored."""
    result = await fetch_feed(url, settings=get_settings())
    parsed = parse_ics(result.body, feed_id="preview")
    return len(parsed.events), parsed.name, parsed.skipped
