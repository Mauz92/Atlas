"""Microsoft Graph calendar adapter (read-only, M5-04, ADR-0071).

Built on documented Graph v1.0 shapes via ``httpx`` (no Microsoft SDK):

- ``calendar: list`` - https://learn.microsoft.com/en-us/graph/api/user-list-calendars
- ``event: delta`` (calendarView) - https://learn.microsoft.com/en-us/graph/api/event-delta
- delta query concepts (``@odata.nextLink``, ``@odata.deltaLink``, ``@removed``, ``410``) -
  https://learn.microsoft.com/en-us/graph/delta-query-overview
- throttling (``429`` + ``Retry-After``) - https://learn.microsoft.com/en-us/graph/throttling
- ``Prefer: outlook.timezone`` and ``IdType="ImmutableId"`` -
  https://learn.microsoft.com/en-us/graph/outlook-immutable-id

**Decision (ADR-0071 D5): Graph expands recurrences.** The only delta endpoint for events is
``calendarView/delta`` over a *time window*, which returns each occurrence and exception as its own
event (``type`` = ``occurrence`` / ``exception`` / ``singleInstance``; no series masters). Atlas
therefore stores Graph occurrences as ordinary events (``series_id`` = ``seriesMasterId``) and does
no local expansion for Microsoft. The window is ``CALENDAR_WINDOW_PAST_DAYS`` back and
``CALENDAR_WINDOW_FUTURE_DAYS`` ahead; because a delta link is bound to its window, the adapter
restarts as a full, snapshot listing when the stored window gets close to ``now`` (or on ``410``).

All times are requested in UTC (``Prefer: outlook.timezone="UTC"``) and the event's own zone is
recovered from ``originalStartTimeZone`` (Windows or IANA name, resolved by
:mod:`atlas.calendar.timezones`); an all-day event is re-read as local midnight in that zone so its
date never shifts.

The cursor is ``"{window_end}|{deltaLink}"`` (opaque to the sync layer); ``@odata.nextLink`` is the
page token and must stay on the Graph origin before the bearer token is sent to it.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from urllib.parse import quote
from zoneinfo import ZoneInfo

from ..config import get_settings
from .errors import AuthExpiredError, PermanentProviderError
from .google import EPOCH, clip
from .http import CursorExpiredError, ProviderHttp
from .ids import event_key
from .oauth import MICROSOFT, TokenManager, endpoints_for
from .timezones import resolve_zone
from .tokens import StoredCredential
from .types import Calendar, CursorType, Event, EventDeletion, EventPage, EventStatus

PAGE_SIZE = 100
#: Restart the window when fewer than this many days of it remain ahead of "now".
WINDOW_RENEW_MARGIN = timedelta(days=30)
_PREFER = 'outlook.timezone="UTC", IdType="ImmutableId"'


def _graph_instant(node: Any) -> datetime | None:
    """A Graph ``dateTimeTimeZone`` requested in UTC, as an aware UTC instant."""
    if not isinstance(node, dict):
        return None
    raw = node.get("dateTime")
    if not isinstance(raw, str):
        return None
    text = raw.strip()
    if "." in text:  # 7 fractional digits: trim to microseconds
        head, _, fraction = text.partition(".")
        text = f"{head}.{fraction[:6].rstrip('Z')}"
    parsed = datetime.fromisoformat(text.rstrip("Z"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def convert_calendar(item: dict[str, Any]) -> Calendar | None:
    calendar_id = item.get("id")
    if not isinstance(calendar_id, str) or not calendar_id:
        return None
    return Calendar(
        id=calendar_id,
        provider=MICROSOFT,
        name=clip(item.get("name"), 200) or "Calendar",
        time_zone="UTC",
        is_read_only=item.get("canEdit") is False,
        is_primary=bool(item.get("isDefaultCalendar")),
    )


def convert_event(item: dict[str, Any], *, calendar_id: str) -> Event | EventDeletion | None:
    raw_id = item.get("id")
    if not isinstance(raw_id, str) or not raw_id:
        return None
    key = event_key(calendar_id, raw_id)
    if "@removed" in item:
        return EventDeletion(id=key, calendar_id=calendar_id, provider=MICROSOFT)
    start = _graph_instant(item.get("start"))
    end = _graph_instant(item.get("end"))
    if start is None:
        return None
    end = end or start
    zone = resolve_zone(item.get("originalStartTimeZone"), "UTC")
    all_day = bool(item.get("isAllDay"))
    if all_day:
        local = start.astimezone(ZoneInfo(zone))
        if local.time() != time.min:  # the zone was unknown or UTC-shifted: keep the UTC day
            zone = "UTC"
            local = start
        first = local.date()
        local_end = end.astimezone(ZoneInfo(zone))
        last = (
            local_end.date()
            if local_end.time() == time.min
            else local_end.date() + timedelta(days=1)
        )
        if last <= first:
            last = first + timedelta(days=1)
        tz = ZoneInfo(zone)
        start = datetime.combine(first, time.min, tzinfo=tz).astimezone(UTC)
        end = datetime.combine(last, time.min, tzinfo=tz).astimezone(UTC)
    if end < start:
        end = start
    modified = item.get("lastModifiedDateTime")
    try:
        updated = (
            datetime.fromisoformat(modified.replace("Z", "+00:00")).astimezone(UTC)
            if isinstance(modified, str)
            else EPOCH
        )
    except ValueError:
        updated = EPOCH
    master = item.get("seriesMasterId")
    location = item.get("location")
    response = item.get("responseStatus")
    tentative = isinstance(response, dict) and response.get("response") == "tentativelyAccepted"
    if item.get("isCancelled"):
        status = EventStatus.CANCELLED
    elif tentative or item.get("showAs") == "tentative":
        status = EventStatus.TENTATIVE
    else:
        status = EventStatus.CONFIRMED
    return Event(
        id=key,
        calendar_id=calendar_id,
        provider=MICROSOFT,
        summary=clip(item.get("subject"), 1000),
        start=start,
        end=end,
        time_zone=zone,
        updated=updated,
        is_all_day=all_day,
        status=status,
        etag=item.get("changeKey") if isinstance(item.get("changeKey"), str) else None,
        ical_uid=clip(item.get("iCalUId"), 512),
        location=clip(location.get("displayName"), 500) if isinstance(location, dict) else None,
        description=clip(item.get("bodyPreview"), 4000),
        web_link=clip(item.get("webLink"), 1000),
        series_id=event_key(calendar_id, master) if isinstance(master, str) and master else None,
    )


def _date_param(moment: datetime) -> str:
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


class MicrosoftCalendarAdapter:
    """:class:`~atlas.calendar.adapter.CalendarAdapter` for Microsoft Graph (read-only)."""

    provider = MICROSOFT
    cursor_type = CursorType.DELTA_LINK

    def __init__(
        self,
        credential: StoredCredential,
        *,
        http: ProviderHttp | None = None,
        tokens: TokenManager | None = None,
        now: datetime | None = None,
    ) -> None:
        endpoints = endpoints_for(MICROSOFT, get_settings())
        self._base = endpoints.api_base
        self._http = http or ProviderHttp(provider=MICROSOFT, api_origin=endpoints.api_origin)
        self.tokens = tokens or TokenManager(MICROSOFT, credential)
        self._fixed_now = now

    def _now(self) -> datetime:
        return self._fixed_now or datetime.now(UTC)

    async def _get(self, url: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        headers = {"Prefer": f"odata.maxpagesize={PAGE_SIZE}, {_PREFER}"}
        token = await self.tokens.access_token()
        try:
            return await self._http.get_json(url, token=token, params=params, headers=headers)
        except AuthExpiredError:
            token = await self.tokens.access_token(force_refresh=True)
            return await self._http.get_json(url, token=token, params=params, headers=headers)

    async def list_calendars(self) -> Sequence[Calendar]:
        calendars: list[Calendar] = []
        url: str | None = f"{self._base}/me/calendars"
        params: dict[str, Any] | None = {"$top": 100}
        while url:
            data = await self._get(url, params)
            for item in data.get("value", []):
                if isinstance(item, dict):
                    calendar = convert_calendar(item)
                    if calendar is not None:
                        calendars.append(calendar)
            next_link = data.get("@odata.nextLink")
            url, params = (next_link if isinstance(next_link, str) else None), None
        return calendars

    def _usable_cursor(self, cursor: str | None) -> str | None:
        """The delta link inside ``cursor`` if its window still covers enough of the future."""
        if not cursor or "|" not in cursor:
            return None
        window_end, _, link = cursor.partition("|")
        try:
            end = datetime.fromisoformat(window_end.replace("Z", "+00:00"))
        except ValueError:
            return None
        return link if end - self._now() > WINDOW_RENEW_MARGIN and link else None

    async def list_events(
        self,
        calendar_id: str,
        *,
        cursor: str | None = None,
        page_token: str | None = None,
        page_size: int | None = None,
    ) -> EventPage:
        link = self._usable_cursor(cursor)
        mode = "inc" if link else "full"
        next_url: str | None = None
        window_end = self._now() + timedelta(days=get_settings().calendar_window_future_days)
        if page_token:
            prefix, _, rest = page_token.partition(":")
            if prefix not in {"inc", "full"} or not rest:
                raise PermanentProviderError("the page token is not valid", provider=MICROSOFT)
            mode, next_url = prefix, rest
        prior_window = _window_of(cursor)
        try:
            return await self._page(calendar_id, mode, link, next_url, window_end, prior_window)
        except CursorExpiredError:
            if mode != "inc":
                raise
            return await self._page(calendar_id, "full", None, None, window_end, None)

    async def _page(
        self,
        calendar_id: str,
        mode: str,
        delta_link: str | None,
        next_url: str | None,
        window_end: datetime,
        prior_window: str | None,
    ) -> EventPage:
        params: dict[str, Any] | None = None
        if next_url:
            url = next_url
        elif mode == "inc" and delta_link:
            url = delta_link
        else:
            settings = get_settings()
            now = self._now()
            url = f"{self._base}/me/calendars/{quote(calendar_id, safe='')}/calendarView/delta"
            params = {
                "startDateTime": _date_param(
                    now - timedelta(days=settings.calendar_window_past_days)
                ),
                "endDateTime": _date_param(window_end),
            }
        if not self._http.allows(url):
            raise PermanentProviderError(
                "the provider returned a link to another host", provider=MICROSOFT
            )
        data = await self._get(url, params)

        events: list[Event] = []
        deletions: list[EventDeletion] = []
        for item in data.get("value", []):
            if not isinstance(item, dict):
                continue
            try:
                converted = convert_event(item, calendar_id=calendar_id)
            except (ValueError, KeyError, TypeError):
                continue
            if isinstance(converted, Event):
                events.append(converted)
            elif isinstance(converted, EventDeletion):
                deletions.append(converted)

        next_link = data.get("@odata.nextLink")
        if isinstance(next_link, str) and next_link:
            return EventPage(
                events=tuple(events),
                deletions=tuple(deletions),
                next_page_token=f"{mode}:{next_link}",
            )
        delta = data.get("@odata.deltaLink")
        if not isinstance(delta, str) or not delta:
            cursor_value = None
        elif mode == "inc":
            # keep the original window end: the window is bound to the delta link
            cursor_value = f"{prior_window or _date_param(window_end)}|{delta}"
        else:
            cursor_value = f"{_date_param(window_end)}|{delta}"
        return EventPage(
            events=tuple(events),
            deletions=tuple(deletions),
            next_cursor=cursor_value,
            is_snapshot=mode == "full",
        )


def _window_of(cursor: str | None) -> str | None:
    if cursor and "|" in cursor:
        return cursor.partition("|")[0]
    return None


def microsoft_adapter_factory(credential: StoredCredential) -> MicrosoftCalendarAdapter:
    return MicrosoftCalendarAdapter(credential)


__all__ = [
    "MicrosoftCalendarAdapter",
    "convert_calendar",
    "convert_event",
    "date",
    "microsoft_adapter_factory",
]
