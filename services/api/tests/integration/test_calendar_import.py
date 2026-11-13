"""Manual ``.ics`` file import (M5-12, ADR-0076 D4) over HTTP + PostgreSQL.

No network at all: the file body lives on the source row and is read by the same parser as a feed.
"""

from __future__ import annotations

import httpx
import pytest
from sqlalchemy import select

from atlas.db import session_scope
from atlas.models import CalendarSource, ExternalEvent
from tests.conftest import create_user_via_setup, csrf_headers

pytestmark = pytest.mark.usefixtures("_db")


def ics(
    *events: str, head: str = "X-WR-TIMEZONE:Europe/Berlin\r\nX-WR-CALNAME:Exported\r\n"
) -> str:
    body = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//fixture//EN\r\n" + head
    body += "".join(f"BEGIN:VEVENT\r\n{e.strip()}\r\nEND:VEVENT\r\n" for e in events)
    return body + "END:VCALENDAR\r\n"


DENTIST = (
    "UID:dentist\r\nDTSTAMP:20261101T100000Z\r\nDTSTART:20261118T133000Z\r\nDTEND:20261118T143000Z\r\n"
    "SUMMARY:Dentist\r\nLOCATION:Main St\r\nDESCRIPTION:Bring the card"
)
TRIP = (
    "UID:trip\r\nDTSTAMP:20261101T100000Z\r\nDTSTART;VALUE=DATE:20261124\r\n"
    "DTEND;VALUE=DATE:20261127\r\nSUMMARY:Trip"
)
STANDUP = (
    "UID:standup\r\nDTSTAMP:20261101T100000Z\r\nDTSTART;TZID=Europe/Berlin:20261110T090000\r\n"
    "DTEND;TZID=Europe/Berlin:20261110T093000\r\nSUMMARY:Standup\r\nRRULE:FREQ=DAILY;COUNT=3"
)
# What Outlook exports: a Windows zone name with its own VTIMEZONE, and a Google export: UTC + X-WR.
OUTLOOK = (
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:Microsoft Exchange Server 2010\r\n"
    "BEGIN:VTIMEZONE\r\nTZID:W. Europe Standard Time\r\nBEGIN:STANDARD\r\nDTSTART:16010101T030000\r\n"
    "TZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\nRRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10\r\n"
    "END:STANDARD\r\nBEGIN:DAYLIGHT\r\nDTSTART:16010101T020000\r\nTZOFFSETFROM:+0100\r\n"
    "TZOFFSETTO:+0200\r\nRRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3\r\nEND:DAYLIGHT\r\n"
    "END:VTIMEZONE\r\nBEGIN:VEVENT\r\nUID:outlook-1\r\nDTSTAMP:20261101T100000Z\r\n"
    "DTSTART;TZID=W. Europe Standard Time:20261120T140000\r\n"
    "DTEND;TZID=W. Europe Standard Time:20261120T150000\r\nSUMMARY:Review\r\nEND:VEVENT\r\n"
    "END:VCALENDAR\r\n"
)


async def _login(client) -> dict[str, str]:
    await create_user_via_setup(client)
    return csrf_headers(client)


async def _import(client, headers, content: str, *, name: str = "From file") -> httpx.Response:
    return await client.post(
        "/api/calendar/imports", json={"name": name, "content": content}, headers=headers
    )


async def _sync(client, headers) -> httpx.Response:
    return await client.post("/api/calendar/providers/ics/sync", headers=headers)


async def _events(client, start="2026-11-01T00:00:00Z", end="2026-12-01T00:00:00Z"):
    response = await client.get("/api/calendar/events", params={"start": start, "end": end})
    assert response.status_code == 200, response.text
    return response.json()


async def test_an_imported_file_becomes_a_read_only_calendar_without_any_network(client) -> None:
    headers = await _login(client)
    created = await _import(client, headers, ics(DENTIST, TRIP))
    assert created.status_code == 201, created.text
    source = created.json()
    assert source["provider"] == "ics" and source["is_import"] and source["is_read_only"]
    assert source["feed_url_display"] == "Imported file"
    synced = (await _sync(client, headers)).json()["calendars"][0]
    assert synced["created"] == 2
    titles = sorted(e["title"] for e in (await _events(client))["events"])
    assert titles == ["Dentist", "Trip"]
    async with session_scope() as session:
        row = (await session.scalars(select(CalendarSource))).one()
        assert row.feed_url_ciphertext is None and row.imported_at is not None


async def test_recurring_all_day_and_foreign_zone_exports_are_read_correctly(client) -> None:
    headers = await _login(client)
    assert (await _import(client, headers, ics(STANDUP, TRIP), name="Google")).status_code == 201
    assert (await _import(client, headers, OUTLOOK, name="Outlook")).status_code == 201
    await _sync(client, headers)
    events = (await _events(client))["events"]
    standups = [e for e in events if e["title"] == "Standup"]
    assert len(standups) == 3  # the RRULE is expanded locally
    trip = next(e for e in events if e["title"] == "Trip")
    assert trip["is_all_day"] and trip["start_date"] == "2026-11-24"
    review = next(e for e in events if e["title"] == "Review")
    assert review["start"].startswith("2026-11-20T13:00:00")  # 14:00 in "W. Europe Standard Time"


async def test_preview_reports_counts_and_stores_nothing(client) -> None:
    headers = await _login(client)
    bad = ics(DENTIST, "UID:broken\r\nSUMMARY:No start")
    response = await client.post(
        "/api/calendar/imports/preview", json={"content": bad}, headers=headers
    )
    assert response.status_code == 200, response.text
    assert response.json() == {"event_count": 1, "name": "Exported", "skipped": 1}
    async with session_scope() as session:
        assert (await session.scalars(select(CalendarSource))).first() is None


async def test_files_that_are_not_calendars_or_are_too_large_are_refused(client) -> None:
    headers = await _login(client)
    for path, extra in (
        ("/api/calendar/imports", {"name": "x"}),
        ("/api/calendar/imports/preview", {}),
    ):
        response = await client.post(
            path, json={"content": "hello, this is not a calendar", **extra}, headers=headers
        )
        assert response.status_code == 400, (path, response.text)
        assert response.json()["detail"]["code"] == "not_calendar"
    huge = "BEGIN:VCALENDAR\r\n" + "X-PAD:" + "a" * (5 * 1024 * 1024 + 10) + "\r\nEND:VCALENDAR\r\n"
    response = await _import(client, headers, huge)
    assert response.status_code == 400 and response.json()["detail"]["code"] == "too_large"
    over = await client.post(
        "/api/calendar/imports", json={"name": "x", "content": "a" * 6_000_001}, headers=headers
    )
    assert over.status_code == 422
    async with session_scope() as session:
        assert (await session.scalars(select(CalendarSource))).first() is None


async def test_replacing_the_file_updates_in_place_and_removes_what_vanished(client) -> None:
    headers = await _login(client)
    source = (await _import(client, headers, ics(DENTIST, TRIP))).json()
    await _sync(client, headers)
    before = {e["title"]: e["id"] for e in (await _events(client))["events"]}
    moved = DENTIST.replace("20261118T133000Z", "20261119T133000Z").replace(
        "20261118T143000Z", "20261119T143000Z"
    )
    replaced = await client.put(
        f"/api/calendar/imports/{source['id']}", json={"content": ics(moved)}, headers=headers
    )
    assert replaced.status_code == 200, replaced.text
    result = (await _sync(client, headers)).json()["calendars"][0]
    assert result["updated"] == 1 and result["tombstoned"] == 1
    after = {e["title"]: e for e in (await _events(client))["events"]}
    assert set(after) == {"Dentist"} and after["Dentist"]["id"] == before["Dentist"]
    assert after["Dentist"]["start"].startswith("2026-11-19T13:30")


async def test_importing_the_same_file_again_is_a_no_op(client) -> None:
    headers = await _login(client)
    body = ics(DENTIST, TRIP)
    source = (await _import(client, headers, body)).json()
    await _sync(client, headers)
    await client.put(
        f"/api/calendar/imports/{source['id']}", json={"content": body}, headers=headers
    )
    again = (await _sync(client, headers)).json()["calendars"][0]
    assert again["created"] == 0 and again["updated"] == 0 and again["tombstoned"] == 0


async def test_only_an_imported_calendar_can_be_replaced_and_removing_it_removes_its_events(
    client,
) -> None:
    headers = await _login(client)
    source = (await _import(client, headers, ics(DENTIST))).json()
    await _sync(client, headers)
    other = await client.put(
        "/api/calendar/imports/00000000-0000-0000-0000-000000000000",
        json={"content": ics(DENTIST)},
        headers=headers,
    )
    assert other.status_code == 404
    removed = await client.delete(f"/api/calendar/feeds/{source['id']}", headers=headers)
    assert removed.status_code == 204
    async with session_scope() as session:
        assert (await session.scalars(select(ExternalEvent))).first() is None
        assert (await session.scalars(select(CalendarSource))).first() is None
    assert (await _events(client))["events"] == []


async def test_an_imported_file_is_user_scoped_and_listing_never_returns_its_bytes(
    client, app
) -> None:
    headers = await _login(client)
    source = (await _import(client, headers, ics(DENTIST))).json()
    await _sync(client, headers)
    listing = await client.get("/api/calendar/accounts")
    assert "BEGIN:VCALENDAR" not in listing.text and "Dentist" not in listing.text
    from atlas.auth.passwords import hash_password
    from atlas.models import User

    async with session_scope() as session:
        session.add(
            User(
                email="two@example.com",
                display_name="Two",
                password_hash=hash_password("correct horse battery"),
            )
        )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as other:
        login = await other.post(
            "/api/auth/login",
            json={"email": "two@example.com", "password": "correct horse battery"},
        )
        assert login.status_code == 200
        other_headers = csrf_headers(other)
        assert (
            await other.put(
                f"/api/calendar/imports/{source['id']}",
                json={"content": ics(TRIP)},
                headers=other_headers,
            )
        ).status_code == 404
        assert (await _events(other))["events"] == []
    assert len((await _events(client))["events"]) == 1


async def test_a_broken_feed_does_not_stop_an_imported_calendar_from_syncing(
    client, fake_provider
) -> None:
    from tests.fakes.calendar_provider import PROVIDER

    headers = await _login(client)
    PROVIDER.set_ics("broken.ics", "x", status=404)
    added = await client.post(
        "/api/calendar/feeds",
        json={"url": "http://127.0.0.1:9911/ics/broken.ics", "name": "Broken"},
        headers=headers,
    )
    assert added.status_code == 201, added.text
    assert (await _import(client, headers, ics(DENTIST), name="Zed file")).status_code == 201
    synced = await _sync(client, headers)
    assert synced.status_code == 200, synced.text
    assert [e["title"] for e in (await _events(client))["events"]] == ["Dentist"]
