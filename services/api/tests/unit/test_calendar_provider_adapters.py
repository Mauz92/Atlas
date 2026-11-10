"""Google and Microsoft adapters against the fake provider (documented response shapes; M5-03/04).

The fake (tests/fakes/calendar_provider.py) mirrors the shapes in the Google Calendar API v3 and
Microsoft Graph v1.0 references cited in atlas/calendar/google.py and microsoft.py. This is
deterministic fixture evidence of the *mapping*; compatibility with the real services stays
UNVERIFIED until the live runbook (docs/CALENDAR_SYNC.md) is followed (AGENTS.md §10).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from atlas.calendar.errors import AuthExpiredError, PermanentProviderError, RateLimitedError
from atlas.calendar.google import GoogleCalendarAdapter
from atlas.calendar.http import ProviderHttp
from atlas.calendar.microsoft import MicrosoftCalendarAdapter
from atlas.calendar.oauth import endpoints_for
from atlas.calendar.types import EventStatus
from tests.unit.calendar_support import stored_credential

CAL = "owner@example.test"
MS_CAL = "AAMkAD-cal-1"


async def _no_sleep(_seconds: float) -> None:
    return None


def google(
    fake, *, access: str | None = "ok", refresh: str | None = "fake-refresh-initial"
) -> GoogleCalendarAdapter:
    token = "fake-access-live" if access == "ok" else access
    if access == "ok":
        fake.access_tokens[token] = 9_999_999_999.0
    fake.refresh_tokens["fake-refresh-initial"] = "google"
    http = ProviderHttp(
        provider="google", api_origin=endpoints_for("google").api_origin, sleep=_no_sleep
    )
    return GoogleCalendarAdapter(
        stored_credential("google", access=token, refresh=refresh), http=http
    )


def microsoft(fake, now: datetime | None = None) -> MicrosoftCalendarAdapter:
    fake.access_tokens["fake-access-live"] = 9_999_999_999.0
    fake.refresh_tokens["fake-refresh-initial"] = "microsoft"
    http = ProviderHttp(
        provider="microsoft", api_origin=endpoints_for("microsoft").api_origin, sleep=_no_sleep
    )
    return MicrosoftCalendarAdapter(
        stored_credential("microsoft", access="fake-access-live"), http=http, now=now
    )


def g_event(event_id: str, summary: str, start: str, end: str, **extra) -> dict:
    return {
        "id": event_id,
        "status": "confirmed",
        "summary": summary,
        "etag": f'"{event_id}-1"',
        "updated": "2026-11-01T10:00:00.000Z",
        "start": {"dateTime": start, "timeZone": "Europe/Berlin"},
        "end": {"dateTime": end, "timeZone": "Europe/Berlin"},
        "iCalUID": f"{event_id}@google.com",
        "htmlLink": f"https://www.google.com/calendar/event?eid={event_id}",
        **extra,
    }


async def drain(adapter, calendar_id, cursor=None):
    events, deletions, page_token, pages = [], [], None, 0
    while True:
        page = await adapter.list_events(calendar_id, cursor=cursor, page_token=page_token)
        pages += 1
        events += page.events
        deletions += page.deletions
        if not page.has_more:
            return events, deletions, page, pages
        page_token = page.next_page_token


# --- Google ----------------------------------------------------------------


async def test_google_lists_calendars_with_zone_role_and_primary(fake_provider) -> None:
    calendars = {c.name: c for c in await google(fake_provider).list_calendars()}
    assert calendars["Owner"].is_primary and not calendars["Owner"].is_read_only
    assert calendars["Owner"].time_zone == "Europe/Berlin"
    assert calendars["Holidays"].is_read_only and not calendars["Holidays"].is_primary


async def test_google_full_sync_maps_timed_all_day_and_recurring_events(fake_provider) -> None:
    fake_provider.put_google_event(
        CAL,
        g_event(
            "t1",
            "Dentist",
            "2026-11-10T09:00:00+01:00",
            "2026-11-10T10:00:00+01:00",
            location="Main St",
        ),
    )
    fake_provider.put_google_event(
        CAL,
        {
            "id": "d1",
            "status": "confirmed",
            "summary": "Holiday",
            "updated": "2026-11-01T10:00:00Z",
            "start": {"date": "2026-12-24"},
            "end": {"date": "2026-12-27"},
        },
    )
    fake_provider.put_google_event(
        CAL,
        g_event(
            "r1",
            "Standup",
            "2026-11-10T09:00:00+01:00",
            "2026-11-10T09:30:00+01:00",
            recurrence=["RRULE:FREQ=DAILY;COUNT=5", "EXDATE;TZID=Europe/Berlin:20261112T090000"],
        ),
    )
    fake_provider.put_google_event(
        CAL,
        g_event(
            "r1_20261111T080000Z",
            "Standup (moved)",
            "2026-11-11T11:00:00+01:00",
            "2026-11-11T11:30:00+01:00",
            recurringEventId="r1",
            originalStartTime={
                "dateTime": "2026-11-11T09:00:00+01:00",
                "timeZone": "Europe/Berlin",
            },
        ),
    )
    fake_provider.cancel_google_event(
        CAL,
        "r1_20261113T080000Z",
        recurringEventId="r1",
        originalStartTime={"dateTime": "2026-11-13T09:00:00+01:00", "timeZone": "Europe/Berlin"},
    )
    events, deletions, last, pages = await drain(google(fake_provider), CAL)
    by_title = {e.summary: e for e in events if e.summary}
    assert (
        not deletions
        and pages == 1
        and last.is_snapshot
        and last.next_cursor == f"st-{fake_provider.rev}"
    )
    dentist = by_title["Dentist"]
    assert (
        dentist.start == datetime(2026, 11, 10, 8, tzinfo=UTC)
        and dentist.time_zone == "Europe/Berlin"
    )
    assert dentist.location == "Main St" and dentist.web_link.startswith("https://www.google.com/")
    holiday = by_title["Holiday"]
    assert holiday.is_all_day and holiday.start == datetime(
        2026, 12, 23, 23, tzinfo=UTC
    )  # local midnight (calendar zone)
    master = by_title["Standup"]
    assert (
        master.recurrence_rule
        == "RRULE:FREQ=DAILY;COUNT=5\nEXDATE;TZID=Europe/Berlin:20261112T090000"
    )
    moved = by_title["Standup (moved)"]
    assert moved.series_id == master.id and moved.recurrence_id == "20261111T080000Z"
    cancelled = next(e for e in events if e.status is EventStatus.CANCELLED)
    assert cancelled.series_id == master.id and cancelled.recurrence_id == "20261113T080000Z"
    assert len({e.id for e in events}) == len(events)


async def test_google_pages_are_walked_and_the_sync_token_only_comes_on_the_last_page(
    fake_provider,
) -> None:
    for i in range(5):
        fake_provider.put_google_event(
            CAL, g_event(f"e{i}", f"E{i}", "2026-11-10T09:00:00+01:00", "2026-11-10T10:00:00+01:00")
        )
    fake_provider.page_size_cap = 2
    adapter = google(fake_provider)
    first = await adapter.list_events(CAL)
    assert first.has_more and first.next_cursor is None and not first.is_snapshot
    events, _, last, pages = await drain(adapter, CAL)
    assert len(events) == 5 and pages == 3 and last.next_cursor and last.is_snapshot


async def test_google_incremental_sync_returns_changes_and_deletions_only(fake_provider) -> None:
    fake_provider.put_google_event(
        CAL, g_event("a", "A", "2026-11-10T09:00:00+01:00", "2026-11-10T10:00:00+01:00")
    )
    fake_provider.put_google_event(
        CAL, g_event("b", "B", "2026-11-11T09:00:00+01:00", "2026-11-11T10:00:00+01:00")
    )
    adapter = google(fake_provider)
    _, _, first, _ = await drain(adapter, CAL)
    fake_provider.put_google_event(
        CAL, g_event("a", "A renamed", "2026-11-10T09:00:00+01:00", "2026-11-10T10:00:00+01:00")
    )
    fake_provider.cancel_google_event(CAL, "b")
    events, deletions, last, _ = await drain(adapter, CAL, cursor=first.next_cursor)
    assert [e.summary for e in events] == ["A renamed"] and len(deletions) == 1
    assert not last.is_snapshot and last.next_cursor != first.next_cursor


async def test_google_410_gone_restarts_as_a_full_snapshot_listing(fake_provider) -> None:
    fake_provider.put_google_event(
        CAL, g_event("a", "A", "2026-11-10T09:00:00+01:00", "2026-11-10T10:00:00+01:00")
    )
    adapter = google(fake_provider)
    _, _, first, _ = await drain(adapter, CAL)
    fake_provider.invalidate_sync_tokens = True
    events, _, last, _ = await drain(adapter, CAL, cursor=first.next_cursor)
    assert [e.summary for e in events] == ["A"] and last.is_snapshot and last.next_cursor


async def test_google_throttling_is_retried_with_retry_after_then_succeeds(fake_provider) -> None:
    fake_provider.failures = [429, 503]
    fake_provider.retry_after = "1"
    assert await google(fake_provider).list_calendars()
    assert fake_provider.failures == []


async def test_google_persistent_throttling_surfaces_a_rate_limit_error(fake_provider) -> None:
    fake_provider.failures = [429] * 10
    fake_provider.retry_after = "120"
    with pytest.raises(RateLimitedError) as raised:
        await google(fake_provider).list_calendars()
    assert raised.value.retry_after == 120.0


async def test_google_a_rejected_access_token_is_refreshed_once_and_exposed_for_persisting(
    fake_provider,
) -> None:
    adapter = google(fake_provider, access="stale-token")
    assert await adapter.list_calendars()
    refreshed = adapter.tokens.refreshed
    assert refreshed is not None and refreshed.access_token != "stale-token"
    assert refreshed.refresh_token == "fake-refresh-initial"  # Google does not rotate it


async def test_google_a_revoked_refresh_token_means_reauthorisation_without_leaking_it(
    fake_provider,
) -> None:
    fake_provider.fail_refresh = True
    adapter = google(fake_provider, access="stale-token")
    with pytest.raises(AuthExpiredError) as raised:
        await adapter.list_calendars()
    assert "fake-refresh-initial" not in str(raised.value) and "stale-token" not in str(
        raised.value
    )


async def test_google_a_missing_calendar_is_a_permanent_error(fake_provider) -> None:
    with pytest.raises(PermanentProviderError):
        await google(fake_provider).list_events("nope@example.test")


async def test_google_one_malformed_event_does_not_fail_the_calendar(fake_provider) -> None:
    fake_provider.put_google_event(
        CAL, g_event("ok", "Fine", "2026-11-10T09:00:00+01:00", "2026-11-10T10:00:00+01:00")
    )
    fake_provider.put_google_event(
        CAL, {"id": "bad", "status": "confirmed", "start": {"dateTime": "not a date"}, "end": {}}
    )
    events, _, _, _ = await drain(google(fake_provider), CAL)
    assert [e.summary for e in events] == ["Fine"]


# --- Microsoft -------------------------------------------------------------


def m_event(event_id: str, subject: str, start: str, end: str, **extra) -> dict:
    return {
        "id": event_id,
        "subject": subject,
        "changeKey": f"ck-{event_id}",
        "type": "singleInstance",
        "lastModifiedDateTime": "2026-11-01T10:00:00Z",
        "isAllDay": False,
        "isCancelled": False,
        "start": {"dateTime": start, "timeZone": "UTC"},
        "end": {"dateTime": end, "timeZone": "UTC"},
        "originalStartTimeZone": "W. Europe Standard Time",
        "iCalUId": f"{event_id}-uid",
        "location": {"displayName": "Room 1"},
        "webLink": f"https://outlook.live.com/owa/?itemid={event_id}",
        "bodyPreview": "Agenda",
        **extra,
    }


async def test_microsoft_lists_calendars(fake_provider) -> None:
    calendars = await microsoft(fake_provider).list_calendars()
    assert [(c.name, c.is_primary, c.is_read_only) for c in calendars] == [
        ("Calendar", True, False)
    ]


async def test_microsoft_delta_maps_zones_all_day_and_occurrences(fake_provider) -> None:
    fake_provider.put_ms_event(
        MS_CAL,
        m_event("m1", "Review", "2026-11-10T08:00:00.0000000", "2026-11-10T09:00:00.0000000"),
    )
    fake_provider.put_ms_event(
        MS_CAL,
        m_event(
            "m2",
            "Holiday",
            "2026-12-23T23:00:00.0000000",
            "2026-12-26T23:00:00.0000000",
            isAllDay=True,
        ),
    )
    fake_provider.put_ms_event(
        MS_CAL,
        m_event(
            "m3",
            "Weekly",
            "2026-11-12T13:00:00.0000000",
            "2026-11-12T14:00:00.0000000",
            type="occurrence",
            seriesMasterId="master-1",
        ),
    )
    fake_provider.put_ms_event(
        MS_CAL,
        m_event(
            "m4",
            "Cancelled",
            "2026-11-13T13:00:00.0000000",
            "2026-11-13T14:00:00.0000000",
            isCancelled=True,
        ),
    )
    adapter = microsoft(fake_provider)
    events, _, last, _ = await drain(adapter, MS_CAL)
    by_title = {e.summary: e for e in events}
    assert 'outlook.timezone="UTC"' in (fake_provider.last_prefer or "") and "ImmutableId" in (
        fake_provider.last_prefer or ""
    )
    review = by_title["Review"]
    assert (
        review.start == datetime(2026, 11, 10, 8, tzinfo=UTC)
        and review.time_zone == "Europe/Berlin"
    )
    assert review.location == "Room 1" and review.etag == "ck-m1"
    holiday = by_title["Holiday"]
    assert holiday.is_all_day and holiday.time_zone == "Europe/Berlin"
    assert holiday.start == datetime(2026, 12, 23, 23, tzinfo=UTC) and holiday.end == datetime(
        2026, 12, 26, 23, tzinfo=UTC
    )
    assert by_title["Weekly"].series_id is not None and by_title["Weekly"].recurrence_rule is None
    assert by_title["Cancelled"].status is EventStatus.CANCELLED
    assert last.is_snapshot and last.next_cursor and "|" in last.next_cursor


async def test_microsoft_pages_follow_next_link_and_delta_link_is_the_cursor(fake_provider) -> None:
    for i in range(5):
        fake_provider.put_ms_event(
            MS_CAL,
            m_event(f"p{i}", f"P{i}", "2026-11-10T08:00:00.0000000", "2026-11-10T09:00:00.0000000"),
        )
    fake_provider.page_size_cap = 2
    adapter = microsoft(fake_provider)
    events, _, last, pages = await drain(adapter, MS_CAL)
    assert len(events) == 5 and pages == 3 and last.next_cursor
    fake_provider.put_ms_event(
        MS_CAL,
        m_event("p0", "P0 changed", "2026-11-10T08:00:00.0000000", "2026-11-10T09:00:00.0000000"),
    )
    fake_provider.remove_ms_event(MS_CAL, "p1")
    events, deletions, last2, _ = await drain(adapter, MS_CAL, cursor=last.next_cursor)
    assert (
        [e.summary for e in events] == ["P0 changed"]
        and len(deletions) == 1
        and not last2.is_snapshot
    )
    # the window bound to the delta link is preserved, not silently extended
    assert last2.next_cursor.split("|")[0] == last.next_cursor.split("|")[0]


async def test_microsoft_410_restarts_as_a_snapshot(fake_provider) -> None:
    fake_provider.put_ms_event(
        MS_CAL, m_event("a", "A", "2026-11-10T08:00:00.0000000", "2026-11-10T09:00:00.0000000")
    )
    adapter = microsoft(fake_provider)
    _, _, first, _ = await drain(adapter, MS_CAL)
    fake_provider.invalidate_sync_tokens = True
    events, _, last, _ = await drain(adapter, MS_CAL, cursor=first.next_cursor)
    assert [e.summary for e in events] == ["A"] and last.is_snapshot


async def test_microsoft_a_window_nearing_its_end_forces_a_fresh_snapshot(fake_provider) -> None:
    fake_provider.put_ms_event(
        MS_CAL, m_event("a", "A", "2026-11-10T08:00:00.0000000", "2026-11-10T09:00:00.0000000")
    )
    first_run = microsoft(fake_provider, now=datetime(2026, 11, 10, tzinfo=UTC))
    _, _, first, _ = await drain(first_run, MS_CAL)
    later = microsoft(fake_provider, now=datetime(2026, 11, 10, tzinfo=UTC) + timedelta(days=340))
    _, _, renewed, _ = await drain(later, MS_CAL, cursor=first.next_cursor)
    assert renewed.is_snapshot and fake_provider.last_query.get("startDateTime")


async def test_microsoft_throttling_and_reauth_use_the_shared_taxonomy(fake_provider) -> None:
    fake_provider.failures = [429]
    fake_provider.retry_after = "2"
    assert await microsoft(fake_provider).list_calendars()
    fake_provider.fail_refresh = True
    http = ProviderHttp(
        provider="microsoft", api_origin=endpoints_for("microsoft").api_origin, sleep=_no_sleep
    )
    stale = MicrosoftCalendarAdapter(stored_credential("microsoft", access="stale"), http=http)
    fake_provider.refresh_tokens["fake-refresh-initial"] = "microsoft"
    with pytest.raises(AuthExpiredError):
        await stale.list_calendars()


async def test_microsoft_refuses_a_next_link_on_another_host(fake_provider) -> None:
    adapter = microsoft(fake_provider)
    with pytest.raises(PermanentProviderError):
        await adapter.list_events(MS_CAL, page_token="full:https://evil.example.test/steal?x=1")
