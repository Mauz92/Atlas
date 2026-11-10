"""Provider sync through the real adapters + fake provider: cursors, resync, fault injection, scans.

Covers AGENTS.md §10 for the new adapters: the cursor advances only with the committed changes (crash
between applying a page and saving the cursor), a full resync after ``410`` tombstones what vanished,
the reconciliation scan syncs only selected calendars, polls feeds at their own interval, skips an
account that needs re-authorising and survives a failing calendar.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select, update
from starlette.responses import JSONResponse

from atlas.calendar import CalendarSyncService
from atlas.calendar.reconcile import CalendarReconciliationService
from atlas.calendar.registry import production_registry
from atlas.config import get_settings
from atlas.db import session_scope
from atlas.jobs.handlers import enqueue_calendar_sync, sync_user_calendars
from atlas.models import (
    CalendarSource,
    ExternalEvent,
    Job,
    ProviderCredential,
    SyncCursor,
    User,
)
from tests.fakes.calendar_provider import PROVIDER
from tests.integration.test_calendar_oauth_api import _connect, _login, _result

pytestmark = pytest.mark.usefixtures("_db")

CAL = "owner@example.test"
HOLIDAYS = "holidays@group.v.calendar.example.test"


def g_event(event_id: str, summary: str, day: int = 10, **extra) -> dict:
    return {
        "id": event_id,
        "status": "confirmed",
        "summary": summary,
        "etag": f'"{event_id}-{summary}"',
        "updated": "2026-11-01T10:00:00Z",
        "start": {"dateTime": f"2026-11-{day:02d}T09:00:00+01:00", "timeZone": "Europe/Berlin"},
        "end": {"dateTime": f"2026-11-{day:02d}T10:00:00+01:00", "timeZone": "Europe/Berlin"},
        **extra,
    }


async def _connected(client) -> tuple[dict[str, str], str]:
    headers = await _login(client)
    assert _result(await _connect(client, headers))["calendar_result"] == "connected"
    async with session_scope() as session:
        user_id = (await session.scalars(select(User.id))).one()
    return headers, str(user_id)


async def _live_titles() -> list[str]:
    async with session_scope() as session:
        rows = await session.scalars(
            select(ExternalEvent.summary)
            .where(ExternalEvent.deleted_at.is_(None))
            .order_by(ExternalEvent.summary)
        )
        return [r for r in rows if r]


async def _cursor() -> str | None:
    async with session_scope() as session:
        return await session.scalar(
            select(SyncCursor.cursor_value).where(SyncCursor.calendar_id == CAL)
        )


async def test_incremental_sync_applies_changes_deletions_and_advances_the_token(
    client, fake_provider
) -> None:
    headers, _ = await _connected(client)
    fake_provider.put_google_event(CAL, g_event("a", "Alpha"))
    fake_provider.put_google_event(CAL, g_event("b", "Beta", 11))
    assert (
        await client.post("/api/calendar/providers/google/sync", headers=headers)
    ).status_code == 200
    first = await _cursor()
    assert await _live_titles() == ["Alpha", "Beta"] and first

    fake_provider.put_google_event(CAL, g_event("a", "Alpha 2"))
    fake_provider.cancel_google_event(CAL, "b")
    result = (await client.post("/api/calendar/providers/google/sync", headers=headers)).json()[
        "calendars"
    ][0]
    assert (result["updated"], result["tombstoned"], result["cursor_advanced"]) == (1, 1, True)
    assert await _live_titles() == ["Alpha 2"] and await _cursor() != first
    again = (await client.post("/api/calendar/providers/google/sync", headers=headers)).json()[
        "calendars"
    ][0]
    assert again["created"] == again["updated"] == again["tombstoned"] == 0


async def test_410_gone_resyncs_in_full_and_tombstones_events_missing_from_the_new_listing(
    client, fake_provider
) -> None:
    headers, _ = await _connected(client)
    fake_provider.put_google_event(CAL, g_event("a", "Alpha"))
    fake_provider.put_google_event(CAL, g_event("b", "Beta", 11))
    await client.post("/api/calendar/providers/google/sync", headers=headers)
    # b disappears while the sync token is invalidated: only a full listing can reveal that
    fake_provider.google_events[CAL] = [
        e for e in fake_provider.google_events[CAL] if e["id"] != "b"
    ]
    fake_provider.invalidate_sync_tokens = True
    result = (await client.post("/api/calendar/providers/google/sync", headers=headers)).json()[
        "calendars"
    ][0]
    assert result["tombstoned"] == 1 and await _live_titles() == ["Alpha"]


async def test_a_google_series_with_an_exception_and_a_cancelled_occurrence_expands_in_the_view(
    client, fake_provider
) -> None:
    headers, _ = await _connected(client)
    fake_provider.put_google_event(
        CAL, g_event("r1", "Standup", recurrence=["RRULE:FREQ=DAILY;COUNT=5"])
    )
    fake_provider.put_google_event(
        CAL,
        g_event(
            "r1_20261111T080000Z",
            "Standup (moved)",
            11,
            recurringEventId="r1",
            originalStartTime={
                "dateTime": "2026-11-11T09:00:00+01:00",
                "timeZone": "Europe/Berlin",
            },
        ),
    )
    fake_provider.cancel_google_event(
        CAL,
        "r1_20261112T080000Z",
        recurringEventId="r1",
        originalStartTime={"dateTime": "2026-11-12T09:00:00+01:00", "timeZone": "Europe/Berlin"},
    )
    await client.post("/api/calendar/providers/google/sync", headers=headers)
    events = (
        await client.get(
            "/api/calendar/events",
            params={"start": "2026-11-01T00:00:00Z", "end": "2026-12-01T00:00:00Z"},
        )
    ).json()["events"]
    assert [(e["title"], e["start"][:13]) for e in events] == [
        ("Standup", "2026-11-10T08"),
        ("Standup (moved)", "2026-11-11T08"),
        ("Standup", "2026-11-13T08"),
        ("Standup", "2026-11-14T08"),
    ]
    assert all(e["provider"] == "google" for e in events)


async def test_a_crash_between_applying_a_page_and_saving_the_cursor_loses_and_duplicates_nothing(
    client, fake_provider, monkeypatch
) -> None:
    headers, _ = await _connected(client)
    fake_provider.put_google_event(CAL, g_event("a", "Alpha"))
    await client.post("/api/calendar/providers/google/sync", headers=headers)
    before = await _cursor()
    fake_provider.put_google_event(CAL, g_event("a", "Alpha 2"))
    fake_provider.put_google_event(CAL, g_event("c", "Gamma", 12))
    fake_provider.google_events[CAL].sort(key=lambda e: e["id"])

    original = CalendarSyncService._advance_cursor
    calls = {"n": 0}

    async def crash_once(self, *args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("simulated crash after applying the page, before saving the cursor")
        return await original(self, *args, **kwargs)

    monkeypatch.setattr(CalendarSyncService, "_advance_cursor", crash_once)
    with pytest.raises(RuntimeError, match="simulated crash"):  # surfaces as a 500 in production
        await client.post("/api/calendar/providers/google/sync", headers=headers)
    assert await _cursor() == before and await _live_titles() == ["Alpha"]  # nothing half-applied
    async with session_scope() as session:
        error = await session.scalar(
            select(SyncCursor.last_error).where(SyncCursor.calendar_id == CAL)
        )
        assert error and "simulated crash" in error

    retry = await client.post("/api/calendar/providers/google/sync", headers=headers)
    assert retry.status_code == 200
    assert await _live_titles() == ["Alpha 2", "Gamma"] and await _cursor() != before
    async with session_scope() as session:
        assert len((await session.scalars(select(ExternalEvent.id))).all()) == 2  # no duplicates


async def test_a_snapshot_resync_that_crashes_does_not_tombstone_anything(
    client, fake_provider, monkeypatch
) -> None:
    headers, _ = await _connected(client)
    fake_provider.put_google_event(CAL, g_event("a", "Alpha"))
    fake_provider.put_google_event(CAL, g_event("b", "Beta", 11))
    await client.post("/api/calendar/providers/google/sync", headers=headers)
    fake_provider.google_events[CAL] = [
        e for e in fake_provider.google_events[CAL] if e["id"] != "b"
    ]
    fake_provider.invalidate_sync_tokens = True

    async def boom(self, *args, **kwargs):
        raise RuntimeError("crash while tombstoning")

    monkeypatch.setattr(CalendarSyncService, "_tombstone_absent", boom)
    with pytest.raises(RuntimeError, match="crash while tombstoning"):
        await client.post("/api/calendar/providers/google/sync", headers=headers)
    assert await _live_titles() == ["Alpha", "Beta"]  # the rollback kept b alive until a clean pass


async def test_a_failure_on_a_later_page_applies_nothing_and_keeps_the_cursor(
    client, fake_provider
) -> None:
    headers, _ = await _connected(client)
    for i in range(4):
        fake_provider.put_google_event(CAL, g_event(f"e{i}", f"E{i}", 10 + i))
    fake_provider.page_size_cap = 2
    # the first events call succeeds (page 1), the second one fails permanently
    original_failure = type(fake_provider).failure
    state = {"calls": 0}

    def failing(self):
        state["calls"] += 1
        if state["calls"] == 3:
            return JSONResponse({"error": {"code": 404}}, 404)
        return original_failure(self)

    type(fake_provider).failure = failing
    try:
        response = await client.post("/api/calendar/providers/google/sync", headers=headers)
    finally:
        type(fake_provider).failure = original_failure
    assert response.status_code == 502 and await _live_titles() == [] and await _cursor() is None


async def test_the_scan_syncs_only_selected_calendars_and_only_when_due(
    client, fake_provider
) -> None:
    _headers, _user_id = await _connected(client)
    fake_provider.put_google_event(CAL, g_event("a", "Alpha"))
    fake_provider.put_google_event(HOLIDAYS, g_event("h", "Holiday"))
    async with session_scope() as session:
        summary = await CalendarReconciliationService(
            session, registry=production_registry()
        ).scan()
    assert summary.synced == 1 and await _live_titles() == ["Alpha"]  # Holidays is not selected
    async with session_scope() as session:
        again = await CalendarReconciliationService(session, registry=production_registry()).scan()
    assert again.synced == 0 and again.skipped == 1  # not due yet
    async with session_scope() as session:
        forced = await CalendarReconciliationService(session, registry=production_registry()).scan(
            only_due=False
        )
    assert forced.synced == 1


async def test_the_scan_skips_an_account_that_needs_reauthorisation(client, fake_provider) -> None:
    _headers, _ = await _connected(client)
    async with session_scope() as session:
        await session.execute(update(ProviderCredential).values(needs_reauth_at=datetime.now(UTC)))
    before = len(fake_provider.requests)
    async with session_scope() as session:
        summary = await CalendarReconciliationService(
            session, registry=production_registry()
        ).scan()
    assert (
        summary.unavailable == 1 and summary.synced == 0 and len(fake_provider.requests) == before
    )


async def test_a_revoked_grant_found_by_the_scan_flags_the_account_and_stops_hammering(
    client, fake_provider
) -> None:
    _headers, _ = await _connected(client)
    fake_provider.expire_access_tokens()
    fake_provider.fail_refresh = True
    async with session_scope() as session:
        summary = await CalendarReconciliationService(
            session, registry=production_registry()
        ).scan()
    assert summary.failed == 1
    async with session_scope() as session:
        assert (await session.scalar(select(ProviderCredential.needs_reauth_at))) is not None
    card = {
        c["provider"]: c for c in (await client.get("/api/calendar/accounts")).json()["providers"]
    }["google"]
    assert card["needs_reauth"]


async def test_feeds_are_polled_at_their_own_interval_and_one_bad_feed_does_not_stop_the_others(
    client, fake_provider, monkeypatch
) -> None:
    headers = await _login(client)
    body = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:1\r\nDTSTART:20261110T090000Z\r\nSUMMARY:One\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
    PROVIDER.set_ics("good.ics", body)
    PROVIDER.set_ics("bad.ics", "x", status=404)
    for name in ("bad", "good"):
        response = await client.post(
            "/api/calendar/feeds",
            json={"url": f"http://127.0.0.1:9911/ics/{name}.ics", "name": name},
            headers=headers,
        )
        assert response.status_code == 201
    async with session_scope() as session:
        summary = await CalendarReconciliationService(
            session, registry=production_registry()
        ).scan()
    assert (summary.synced, summary.failed) == (1, 1) and await _live_titles() == ["One"]
    hits = PROVIDER.ics["good.ics"]["hits"]
    async with session_scope() as session:
        quiet = await CalendarReconciliationService(session, registry=production_registry()).scan()
    assert (
        PROVIDER.ics["good.ics"]["hits"] == hits and quiet.synced == 0
    )  # the poll interval (>= 5 min) holds
    assert get_settings().ics_poll_seconds >= 300


async def test_the_sync_now_job_syncs_one_user_immediately_and_is_deduplicated(
    client, fake_provider
) -> None:
    _headers, user_id = await _connected(client)
    fake_provider.put_google_event(CAL, g_event("a", "Alpha"))
    async with session_scope() as session:
        await enqueue_calendar_sync(session, uuid.UUID(user_id))
        await enqueue_calendar_sync(session, uuid.UUID(user_id))  # same minute: one job
    async with session_scope() as session:
        jobs = (
            await session.scalars(select(Job).where(Job.task_name == "calendar.sync_user"))
        ).all()
        assert len(jobs) == 1
        await sync_user_calendars(session, jobs[0].payload)
    assert await _live_titles() == ["Alpha"]


async def test_a_hidden_calendar_keeps_its_cursor_when_shown_again(client, fake_provider) -> None:
    headers, _ = await _connected(client)
    fake_provider.put_google_event(CAL, g_event("a", "Alpha"))
    await client.post("/api/calendar/providers/google/sync", headers=headers)
    cursor = await _cursor()
    async with session_scope() as session:
        source = (
            await session.scalars(select(CalendarSource).where(CalendarSource.external_id == CAL))
        ).one()
        source_id = source.id
    await client.patch(
        f"/api/calendar/sources/{source_id}", json={"selected": False}, headers=headers
    )
    await client.patch(
        f"/api/calendar/sources/{source_id}", json={"selected": True}, headers=headers
    )
    assert await _cursor() == cursor
