"""Google Calendar API v3 adapter (read-only, M5-03, ADR-0071).

Built on documented REST shapes via ``httpx`` (no Google SDK; AGENTS.md §7.5/§14):

- ``calendarList.list`` - https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list
- ``events.list`` - https://developers.google.com/workspace/calendar/api/v3/reference/events/list
- incremental sync (``syncToken``, ``410 Gone``) - https://developers.google.com/workspace/calendar/api/guides/sync
- recurring events (``recurrence``, ``recurringEventId``, ``originalStartTime``) -
  https://developers.google.com/workspace/calendar/api/concepts/events-calendars#recurring_events

**Decision (ADR-0071 D4): ``singleEvents=false``.** A recurring series is projected as one master
(its RFC 5545 ``recurrence`` lines) plus the exceptions Google returns as separate events, and
occurrences are expanded locally for the requested window (:mod:`atlas.calendar.recurrence`). This
keeps the ``syncToken`` valid for unbounded series (``singleEvents=true`` would have to enumerate
them) and keeps the projection small. A cancelled occurrence arrives as a ``cancelled`` exception
and is stored as a *cancelled override* so the expansion skips it.

The listing flow: with a ``cursor`` (a ``syncToken``) only changes are fetched; ``410 Gone`` means
the token expired, so the adapter transparently restarts as a **full** listing (page tokens carry a
``full:`` / ``inc:`` prefix so a restart survives across calls) and marks the final page
``is_snapshot`` so the sync layer tombstones what the full listing no longer contains. The
``nextSyncToken`` appears only on the final page; the sync layer persists it only after commit.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from ..config import get_settings
from .errors import AuthExpiredError, PermanentProviderError
from .http import CursorExpiredError, ProviderHttp
from .ids import event_key
from .oauth import GOOGLE, TokenManager, endpoints_for
from .timezones import resolve_zone
from .tokens import StoredCredential
from .types import Calendar, CursorType, Event, EventDeletion, EventPage, EventStatus

MAX_PAGE_SIZE = 250
EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
_INSTANCE_SUFFIX = re.compile(r"_(\d{8}(?:T\d{6}Z)?)$")


def clip(value: object, limit: int) -> str | None:
    """A bounded display string (or ``None``)."""
    if not isinstance(value, str) or not value.strip():
        return None
    return value if len(value) <= limit else value[: limit - 1] + "…"


def parse_instant(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("an instant needs an offset")
    return parsed.astimezone(UTC)


def local_midnight(day: date, zone: str) -> datetime:
    """Midnight of ``day`` in ``zone`` as a UTC instant (the all-day boundary convention)."""
    return datetime.combine(day, time.min, tzinfo=ZoneInfo(zone)).astimezone(UTC)


def recurrence_id_for(instant: datetime) -> str:
    """The canonical ``recurrence_id``: the occurrence's original start as a UTC instant."""
    return instant.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")


def _when(node: Any, default_zone: str) -> tuple[datetime, bool, str] | None:
    """``(instant, is_all_day, zone)`` for a Google ``start``/``end``/``originalStartTime`` node."""
    if not isinstance(node, dict):
        return None
    zone = resolve_zone(node.get("timeZone"), default_zone)
    raw_date = node.get("date")
    if isinstance(raw_date, str):
        return local_midnight(date.fromisoformat(raw_date), zone), True, zone
    raw = node.get("dateTime")
    if isinstance(raw, str):
        return parse_instant(raw), False, zone
    return None


def convert_calendar(item: dict[str, Any]) -> Calendar | None:
    calendar_id = item.get("id")
    if not isinstance(calendar_id, str) or not calendar_id or item.get("deleted"):
        return None
    name = clip(item.get("summaryOverride"), 200) or clip(item.get("summary"), 200) or calendar_id
    return Calendar(
        id=calendar_id,
        provider=GOOGLE,
        name=name,
        time_zone=resolve_zone(item.get("timeZone"), "UTC"),
        is_read_only=item.get("accessRole") in {"reader", "freeBusyReader"},
        is_primary=bool(item.get("primary")),
    )


def convert_event(
    item: dict[str, Any], *, calendar_id: str, default_zone: str
) -> Event | EventDeletion | None:
    """Translate one Google event into an :class:`Event`, an :class:`EventDeletion` or ``None``."""
    raw_id = item.get("id")
    if not isinstance(raw_id, str) or not raw_id:
        return None
    key = event_key(calendar_id, raw_id)
    master = item.get("recurringEventId")
    series_id = event_key(calendar_id, master) if isinstance(master, str) and master else None
    original = _when(item.get("originalStartTime"), default_zone)
    if original is None and series_id is not None:
        match = _INSTANCE_SUFFIX.search(raw_id)
        if match:
            text = match.group(1)
            original = (
                (
                    parse_instant(
                        f"{text[:4]}-{text[4:6]}-{text[6:8]}T{text[9:11]}:{text[11:13]}:{text[13:15]}Z"
                    ),
                    False,
                    default_zone,
                )
                if "T" in text
                else (
                    local_midnight(
                        date(int(text[:4]), int(text[4:6]), int(text[6:8])), default_zone
                    ),
                    True,
                    default_zone,
                )
            )

    if item.get("status") == "cancelled":
        if series_id is not None and original is not None:
            # A cancelled occurrence must keep suppressing the master's expansion.
            instant, all_day, zone = original
            return Event(
                id=key,
                calendar_id=calendar_id,
                provider=GOOGLE,
                summary=None,
                start=instant,
                end=instant,
                time_zone=zone,
                updated=EPOCH,
                is_all_day=all_day,
                status=EventStatus.CANCELLED,
                series_id=series_id,
                recurrence_id=recurrence_id_for(instant),
            )
        return EventDeletion(id=key, calendar_id=calendar_id, provider=GOOGLE)

    start = _when(item.get("start"), default_zone)
    end = _when(item.get("end"), default_zone)
    if start is None:
        return None
    start_at, all_day, zone = start
    end_at = end[0] if end is not None else start_at
    if end_at < start_at:
        end_at = start_at
    updated_raw = item.get("updated")
    try:
        updated = parse_instant(updated_raw) if isinstance(updated_raw, str) else EPOCH
    except ValueError:
        updated = EPOCH
    recurrence = item.get("recurrence")
    rules = (
        "\n".join(line for line in recurrence if isinstance(line, str))
        if isinstance(recurrence, list)
        else None
    )
    return Event(
        id=key,
        calendar_id=calendar_id,
        provider=GOOGLE,
        summary=clip(item.get("summary"), 1000),
        start=start_at,
        end=end_at,
        time_zone=zone,
        updated=updated,
        is_all_day=all_day,
        status=EventStatus.TENTATIVE
        if item.get("status") == "tentative"
        else EventStatus.CONFIRMED,
        etag=item.get("etag") if isinstance(item.get("etag"), str) else None,
        recurrence_id=recurrence_id_for(original[0]) if original and series_id else None,
        recurrence_rule=rules or None,
        ical_uid=clip(item.get("iCalUID"), 512),
        location=clip(item.get("location"), 500),
        description=clip(item.get("description"), 4000),
        web_link=clip(item.get("htmlLink"), 1000),
        series_id=series_id,
    )


class GoogleCalendarAdapter:
    """:class:`~atlas.calendar.adapter.CalendarAdapter` for Google Calendar (read-only)."""

    provider = GOOGLE
    cursor_type = CursorType.SYNC_TOKEN

    def __init__(
        self,
        credential: StoredCredential,
        *,
        http: ProviderHttp | None = None,
        tokens: TokenManager | None = None,
    ) -> None:
        endpoints = endpoints_for(GOOGLE, get_settings())
        self._base = endpoints.api_base
        self._http = http or ProviderHttp(provider=GOOGLE, api_origin=endpoints.api_origin)
        self.tokens = tokens or TokenManager(GOOGLE, credential)
        self._zones: dict[str, str] = {}

    async def _get(self, path: str, params: dict[str, Any]) -> dict[str, Any]:
        url = f"{self._base}{path}"
        token = await self.tokens.access_token()
        try:
            return await self._http.get_json(url, token=token, params=params)
        except AuthExpiredError:
            # One forced refresh: the access token may have been revoked early. A refresh failure
            # (``invalid_grant``) raises AuthExpiredError again and the account needs
            # re-authorising.
            token = await self.tokens.access_token(force_refresh=True)
            return await self._http.get_json(url, token=token, params=params)

    async def list_calendars(self) -> Sequence[Calendar]:
        calendars: list[Calendar] = []
        page: str | None = None
        while True:
            params: dict[str, Any] = {"maxResults": MAX_PAGE_SIZE, "showHidden": "true"}
            if page:
                params["pageToken"] = page
            data = await self._get("/users/me/calendarList", params)
            for item in data.get("items", []):
                if isinstance(item, dict):
                    calendar = convert_calendar(item)
                    if calendar is not None:
                        calendars.append(calendar)
                        self._zones[calendar.id] = calendar.time_zone
            next_page = data.get("nextPageToken")
            if not isinstance(next_page, str) or not next_page:
                return calendars
            page = next_page

    async def list_events(
        self,
        calendar_id: str,
        *,
        cursor: str | None = None,
        page_token: str | None = None,
        page_size: int | None = None,
    ) -> EventPage:
        mode = "inc" if cursor else "full"
        provider_page: str | None = None
        if page_token:
            prefix, _, provider_page = page_token.partition(":")
            if prefix not in {"inc", "full"} or not provider_page:
                raise PermanentProviderError("the page token is not valid", provider=GOOGLE)
            mode = prefix
        try:
            return await self._page(calendar_id, mode, cursor, provider_page, page_size)
        except CursorExpiredError:
            if mode != "inc":
                raise
            # 410 Gone: the syncToken expired. Clear the local cursor view and relist everything.
            return await self._page(calendar_id, "full", None, None, page_size)

    async def _page(
        self,
        calendar_id: str,
        mode: str,
        cursor: str | None,
        provider_page: str | None,
        page_size: int | None,
    ) -> EventPage:
        params: dict[str, Any] = {
            "maxResults": max(1, min(page_size or MAX_PAGE_SIZE, MAX_PAGE_SIZE)),
            "singleEvents": "false",
            "showDeleted": "true",
        }
        if provider_page:
            params["pageToken"] = provider_page
        elif mode == "inc" and cursor:
            params["syncToken"] = cursor
        path = f"/calendars/{_quote(calendar_id)}/events"
        data = await self._get(path, params)

        default_zone = resolve_zone(data.get("timeZone"), self._zones.get(calendar_id, "UTC"))
        events: list[Event] = []
        deletions: list[EventDeletion] = []
        for item in data.get("items", []):
            if not isinstance(item, dict):
                continue
            try:
                converted = convert_event(item, calendar_id=calendar_id, default_zone=default_zone)
            except (ValueError, KeyError, TypeError):
                continue  # one malformed event must not fail the calendar
            if isinstance(converted, Event):
                events.append(converted)
            elif isinstance(converted, EventDeletion):
                deletions.append(converted)

        next_page = data.get("nextPageToken")
        if isinstance(next_page, str) and next_page:
            return EventPage(
                events=tuple(events),
                deletions=tuple(deletions),
                next_page_token=f"{mode}:{next_page}",
            )
        sync_token = data.get("nextSyncToken")
        return EventPage(
            events=tuple(events),
            deletions=tuple(deletions),
            next_cursor=sync_token if isinstance(sync_token, str) and sync_token else None,
            is_snapshot=mode == "full",
        )


def _quote(calendar_id: str) -> str:
    from urllib.parse import quote

    return quote(calendar_id, safe="")


def google_adapter_factory(credential: StoredCredential) -> GoogleCalendarAdapter:
    return GoogleCalendarAdapter(credential)


__all__ = [
    "GoogleCalendarAdapter",
    "convert_calendar",
    "convert_event",
    "google_adapter_factory",
    "timedelta",
]
