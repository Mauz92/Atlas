"""ICS feeds end to end and the unified event view over HTTP + PostgreSQL (M5-07, M5-11).

Feeds are served by the fake provider's ``/ics`` host (no internet, no real Proton account).
"""

from __future__ import annotations

import httpx
import pytest
from sqlalchemy import select, text

from atlas.config import get_settings
from atlas.db import session_scope
from atlas.models import CalendarSource, ExternalEvent, SyncCursor
from tests.conftest import create_user_via_setup, csrf_headers
from tests.fakes.calendar_provider import PROVIDER

pytestmark = pytest.mark.usefixtures("_db")

SECRET = "pL4SECRETfeedTOKEN7788"
FEED_URL = f"http://127.0.0.1:9911/ics/{SECRET}.ics"


def ics(*events: str, head: str = "X-WR-TIMEZONE:Europe/Berlin\r\n") -> str:
    body = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//fixture//EN\r\n" + head
    body += "".join(f"BEGIN:VEVENT\r\n{e.strip()}\r\nEND:VEVENT\r\n" for e in events)
    return body + "END:VCALENDAR\r\n"


STANDUP = (
    "UID:standup\r\nDTSTAMP:20261101T100000Z\r\nDTSTART;TZID=Europe/Berlin:20261110T090000\r\n"
    "DTEND;TZID=Europe/Berlin:20261110T093000\r\nSUMMARY:Standup\r\nRRULE:FREQ=DAILY;COUNT=5\r\n"
    "EXDATE;TZID=Europe/Berlin:20261112T090000"
)
MOVED = (
    "UID:standup\r\nRECURRENCE-ID;TZID=Europe/Berlin:20261111T090000\r\nDTSTAMP:20261101T100000Z\r\n"
    "DTSTART;TZID=Europe/Berlin:20261111T110000\r\nDTEND;TZID=Europe/Berlin:20261111T113000\r\nSUMMARY:Standup (moved)"
)
CANCELLED = (
    "UID:standup\r\nRECURRENCE-ID;TZID=Europe/Berlin:20261113T090000\r\nDTSTAMP:20261101T100000Z\r\n"
    "DTSTART;TZID=Europe/Berlin:20261113T090000\r\nSUMMARY:Standup\r\nSTATUS:CANCELLED"
)
HOLIDAY = "UID:holiday\r\nDTSTAMP:20261101T100000Z\r\nDTSTART;VALUE=DATE:20261124\r\nDTEND;VALUE=DATE:20261127\r\nSUMMARY:Trip"
DENTIST = (
    "UID:dentist\r\nDTSTAMP:20261101T100000Z\r\nDTSTART:20261118T133000Z\r\nDTEND:20261118T143000Z\r\n"
    "SUMMARY:Dentist\r\nLOCATION:Main St\r\nDESCRIPTION:Bring the card\r\nURL:https://example.test/e/1"
)


async def _login(client) -> dict[str, str]:
    await create_user_via_setup(client)
    return csrf_headers(client)


async def _add_feed(client, headers, body: str, *, name: str = "Proton") -> dict:
    PROVIDER.set_ics(f"{SECRET}.ics", body)
    response = await client.post(
        "/api/calendar/feeds", json={"url": FEED_URL, "name": name}, headers=headers
    )
    assert response.status_code == 201, response.text
    return response.json()


async def _sync(client, headers) -> httpx.Response:
    return await client.post("/api/calendar/providers/ics/sync", headers=headers)


async def _events(client, start="2026-11-01T00:00:00Z", end="2026-12-01T00:00:00Z", **params):
    response = await client.get(
        "/api/calendar/events", params={"start": start, "end": end, **params}
    )
    assert response.status_code == 200, response.text
    return response.json()


async def test_a_feed_is_stored_sealed_and_masked_and_never_returned(client, fake_provider) -> None:
    headers = await _login(client)
    source = await _add_feed(client, headers, ics(DENTIST))
    assert source["provider"] == "ics" and source["is_read_only"] and source["selected"]
    assert source["feed_url_display"] == "http://127.0.0.1:9911/••••••••"
    async with session_scope() as session:
        row = (await session.scalars(select(CalendarSource))).one()
        assert SECRET.encode() not in row.feed_url_ciphertext and SECRET not in (
            row.feed_url_display or ""
        )
    listing = await client.get("/api/calendar/accounts")
    assert SECRET not in listing.text and "127.0.0.1:9911/ics" not in listing.text
    assert SECRET not in (await client.get("/api/calendar/sync-status")).text


@pytest.mark.parametrize(
    "url",
    [
        "https://169.254.169.254/latest/meta-data/",
        "https://127.0.0.1/a.ics",
        "https://localhost/a.ics",
        "https://10.0.0.5/a.ics",
        "ftp://example.test/a.ics",
        "https://user:secret@example.test/a.ics",
    ],
)
async def test_ssrf_and_bad_urls_are_refused_when_private_hosts_are_not_allowed(
    client, monkeypatch, url: str
) -> None:
    headers = await _login(client)
    monkeypatch.setattr(get_settings(), "ics_allow_private_hosts", False)
    for path in ("/api/calendar/feeds", "/api/calendar/feeds/preview"):
        response = await client.post(path, json={"url": url, "name": "x"}, headers=headers)
        assert response.status_code == 400, (path, response.text)
    async with session_scope() as session:
        assert (await session.scalars(select(CalendarSource))).first() is None


async def test_validation_errors_do_not_echo_the_feed_url(client, fake_provider) -> None:
    headers = await _login(client)
    response = await client.post(
        "/api/calendar/feeds", json={"url": f"x{SECRET}", "name": ""}, headers=headers
    )
    assert response.status_code in {400, 422} and SECRET not in response.text


async def test_http_feeds_are_refused_unless_explicitly_allowed(
    client, fake_provider, monkeypatch
) -> None:
    headers = await _login(client)
    monkeypatch.setattr(get_settings(), "ics_allow_http", False)
    response = await client.post(
        "/api/calendar/feeds", json={"url": FEED_URL, "name": "x"}, headers=headers
    )
    assert response.status_code == 400 and response.json()["detail"]["code"] == "https_required"


async def test_preview_reports_the_event_count_without_storing_anything(
    client, fake_provider
) -> None:
    headers = await _login(client)
    PROVIDER.set_ics(f"{SECRET}.ics", ics(DENTIST, HOLIDAY), content_type="text/calendar")
    response = await client.post(
        "/api/calendar/feeds/preview", json={"url": FEED_URL}, headers=headers
    )
    assert response.status_code == 200 and response.json() == {
        "event_count": 2,
        "name": None,
        "skipped": 0,
    }
    async with session_scope() as session:
        assert (await session.scalars(select(CalendarSource))).first() is None


async def test_preview_and_add_report_safe_errors_for_broken_feeds(client, fake_provider) -> None:
    headers = await _login(client)
    PROVIDER.set_ics(f"{SECRET}.ics", "<html>nope</html>", content_type="text/html")
    response = await client.post(
        "/api/calendar/feeds/preview", json={"url": FEED_URL}, headers=headers
    )
    assert response.status_code == 400 and response.json()["detail"]["code"] == "not_calendar"
    PROVIDER.set_ics(f"{SECRET}.ics", "x", status=404)
    response = await client.post(
        "/api/calendar/feeds/preview", json={"url": FEED_URL}, headers=headers
    )
    assert response.json()["detail"]["code"] == "rejected" and SECRET not in response.text
    PROVIDER.set_ics(f"{SECRET}.ics", "x", status=503)
    response = await client.post(
        "/api/calendar/feeds/preview", json={"url": FEED_URL}, headers=headers
    )
    assert response.status_code == 502 and SECRET not in response.text


async def test_syncing_a_feed_projects_events_and_the_unified_view_expands_the_series(
    client, fake_provider
) -> None:
    headers = await _login(client)
    source = await _add_feed(client, headers, ics(STANDUP, MOVED, CANCELLED, HOLIDAY, DENTIST))
    assert (await _sync(client, headers)).status_code == 200
    window = await _events(client)
    titles = [(e["title"], e["start"]) for e in window["events"]]
    standups = [e for e in window["events"] if e["title"] and e["title"].startswith("Standup")]
    # master x5: 10, 11(moved), 12(EXDATE), 13(cancelled), 14 -> 10, 14 regular + the moved one at 11:00
    assert [e["start"] for e in standups] == [
        "2026-11-10T08:00:00Z",
        "2026-11-11T10:00:00Z",
        "2026-11-14T08:00:00Z",
    ], titles
    assert (
        standups[1]["title"] == "Standup (moved)"
        and standups[0]["occurrence"] == "20261110T080000Z"
    )
    assert standups[0]["time_zone"] == "Europe/Berlin" and standups[0]["is_recurring"]
    trip = next(e for e in window["events"] if e["title"] == "Trip")
    assert trip["is_all_day"] and (trip["start_date"], trip["end_date"]) == (
        "2026-11-24",
        "2026-11-27",
    )
    assert window["total"] == 5 and not window["truncated"]
    assert all(e["source_id"] == source["id"] and e["provider"] == "ics" for e in window["events"])
    assert not any(
        key in standups[0] for key in ("external_event_id", "calendar_id", "ical_uid", "etag")
    )

    # an occurrence has its own detail; an excluded one does not exist
    master = standups[0]
    detail = await client.get(
        f"/api/calendar/events/{master['id']}", params={"occurrence": master["occurrence"]}
    )
    assert (
        detail.status_code == 200
        and detail.json()["calendar_name"] == "Proton"
        and detail.json()["is_read_only"]
    )
    assert (
        await client.get(
            f"/api/calendar/events/{master['id']}", params={"occurrence": "20261112T080000Z"}
        )
    ).status_code == 404
    dentist = next(e for e in window["events"] if e["title"] == "Dentist")
    info = (await client.get(f"/api/calendar/events/{dentist['id']}")).json()
    assert (
        info["description"] == "Bring the card"
        and info["location"] == "Main St"
        and info["web_link"] == "https://example.test/e/1"
    )


async def test_a_second_sync_is_idempotent_and_uses_a_conditional_request(
    client, fake_provider
) -> None:
    headers = await _login(client)
    await _add_feed(client, headers, ics(DENTIST, HOLIDAY))
    first = (await _sync(client, headers)).json()["calendars"][0]
    second = (await _sync(client, headers)).json()["calendars"][0]
    assert first["created"] == 2 and second["created"] == 0 and second["updated"] == 0
    assert PROVIDER.ics[f"{SECRET}.ics"]["conditional_hits"] == 1  # the 304 path
    async with session_scope() as session:
        assert len((await session.scalars(select(ExternalEvent))).all()) == 2


async def test_feed_edits_update_in_place_and_removed_events_are_tombstoned_by_diffing(
    client, fake_provider
) -> None:
    headers = await _login(client)
    await _add_feed(client, headers, ics(DENTIST, HOLIDAY))
    await _sync(client, headers)
    PROVIDER.set_ics(
        f"{SECRET}.ics", ics(DENTIST.replace("SUMMARY:Dentist", "SUMMARY:Dentist (moved)"))
    )
    result = (await _sync(client, headers)).json()["calendars"][0]
    assert result["updated"] == 1 and result["tombstoned"] == 1
    titles = sorted(e["title"] for e in (await _events(client))["events"])
    assert titles == ["Dentist (moved)"]
    async with session_scope() as session:
        rows = (await session.scalars(select(ExternalEvent))).all()
        assert (
            len(rows) == 2 and sum(r.deleted_at is not None for r in rows) == 1
        )  # tombstone, not delete
    PROVIDER.set_ics(f"{SECRET}.ics", ics(DENTIST, HOLIDAY))  # the event comes back: revived
    await _sync(client, headers)
    assert len((await _events(client))["events"]) == 2


async def test_a_broken_or_revoked_feed_keeps_the_projection_and_records_a_safe_error(
    client, fake_provider
) -> None:
    headers = await _login(client)
    await _add_feed(client, headers, ics(DENTIST))
    await _sync(client, headers)
    for body, kwargs, expected in (
        ("<html>login</html>", {"content_type": "text/html"}, "not a calendar"),
        ("x", {"status": 404}, "link rejected"),
        ("x", {"status": 500}, "unreachable"),
        ("BEGIN:VCALENDAR\r\nGARBAGE", {}, ""),
    ):
        PROVIDER.set_ics(f"{SECRET}.ics", body, **kwargs)
        response = await _sync(client, headers)
        assert response.status_code in {200, 400, 502}
        assert len((await _events(client))["events"]) == 1  # never wiped by a bad fetch
        card = {
            c["provider"]: c
            for c in (await client.get("/api/calendar/accounts")).json()["providers"]
        }["ics"]
        error = card["calendars"][0]["last_error"]
        if expected:
            assert error and expected in error and SECRET not in error
    async with session_scope() as session:
        cursor = (await session.scalars(select(SyncCursor))).one()
        assert cursor.cursor_value is not None  # the last good validator is intact


async def test_hiding_a_calendar_removes_it_from_the_view_and_removing_a_feed_purges_it(
    client, fake_provider
) -> None:
    headers = await _login(client)
    source = await _add_feed(client, headers, ics(DENTIST))
    await _sync(client, headers)
    hidden = await client.patch(
        f"/api/calendar/sources/{source['id']}",
        json={"selected": False, "color": "5"},
        headers=headers,
    )
    assert (
        hidden.status_code == 200
        and hidden.json()["selected"] is False
        and hidden.json()["color"] == "5"
    )
    assert (await _events(client))["events"] == []
    async with session_scope() as session:
        assert (await session.scalars(select(ExternalEvent))).first() is not None  # kept
    await client.patch(
        f"/api/calendar/sources/{source['id']}", json={"selected": True}, headers=headers
    )
    assert len((await _events(client))["events"]) == 1
    assert (
        await client.patch(
            f"/api/calendar/sources/{source['id']}", json={"color": "9"}, headers=headers
        )
    ).status_code == 422
    removed = await client.delete(f"/api/calendar/feeds/{source['id']}", headers=headers)
    assert removed.status_code == 204
    async with session_scope() as session:
        for model in (CalendarSource, ExternalEvent, SyncCursor):
            assert (await session.scalars(select(model))).first() is None


async def test_the_event_window_is_bounded_paginated_and_validated(client, fake_provider) -> None:
    headers = await _login(client)
    many = [
        f"UID:e{i}\r\nDTSTAMP:20261101T100000Z\r\nDTSTART:20261110T{9 + i // 6:02d}{(i % 6) * 10:02d}00Z\r\nSUMMARY:E{i:02d}"
        for i in range(12)
    ]
    await _add_feed(client, headers, ics(*many))
    await _sync(client, headers)
    page1 = await _events(client, limit=5)
    page3 = await _events(client, limit=5, offset=10)
    assert len(page1["events"]) == 5 and page1["total"] == 12 and page1["truncated"]
    assert len(page3["events"]) == 2 and not page3["truncated"]
    assert [e["title"] for e in page1["events"]] == sorted(e["title"] for e in page1["events"])
    for params in (
        {"start": "2026-11-10T00:00:00Z", "end": "2026-11-09T00:00:00Z"},
        {"start": "2026-01-01T00:00:00Z", "end": "2026-12-01T00:00:00Z"},  # > 100 days
        {"start": "2026-11-10T00:00:00", "end": "2026-11-11T00:00:00"},  # naive instants
    ):
        assert (await client.get("/api/calendar/events", params=params)).status_code == 422
    assert (
        await client.get("/api/calendar/events", params={"start": "x", "end": "y"})
    ).status_code == 422
    assert (
        await client.get(
            "/api/calendar/events",
            params={"start": "2026-11-01T00:00:00Z", "end": "2026-11-02T00:00:00Z", "limit": 5000},
        )
    ).status_code == 422


async def test_events_feeds_and_sources_are_strictly_user_scoped(
    client, fake_provider, app
) -> None:
    headers = await _login(client)
    source = await _add_feed(client, headers, ics(DENTIST))
    await _sync(client, headers)
    event = (await _events(client))["events"][0]
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as other:
        setup = await other.post(
            "/api/auth/setup",
            json={
                "email": "two@example.com",
                "password": "correct horse battery",
                "display_name": "Two",
            },
        )
        if setup.status_code != 201:  # single-owner instance: create the second user directly
            await _second_user()
            login = await other.post(
                "/api/auth/login",
                json={"email": "two@example.com", "password": "correct horse battery"},
            )
            assert login.status_code == 200
        other_headers = csrf_headers(other)
        assert (
            await other.get(
                "/api/calendar/events",
                params={"start": "2026-11-01T00:00:00Z", "end": "2026-12-01T00:00:00Z"},
            )
        ).json()["events"] == []
        assert (await other.get(f"/api/calendar/events/{event['id']}")).status_code == 404
        assert (
            await other.patch(
                f"/api/calendar/sources/{source['id']}",
                json={"selected": False},
                headers=other_headers,
            )
        ).status_code == 404
        assert (
            await other.delete(f"/api/calendar/feeds/{source['id']}", headers=other_headers)
        ).status_code == 404
        accounts = (await other.get("/api/calendar/accounts")).json()["providers"]
        assert all(not p["calendars"] for p in accounts)
    assert len((await _events(client))["events"]) == 1


async def _second_user() -> None:
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


async def test_a_task_deadline_never_appears_as_a_calendar_event(client, fake_provider) -> None:
    headers = await _login(client)
    created = await client.post(
        "/api/tasks", json={"title": "Pay rent", "due_date": "2026-11-12"}, headers=headers
    )
    assert created.status_code in {200, 201}, created.text
    assert (await _events(client))[
        "events"
    ] == []  # AGENTS.md §9: a deadline never becomes an event
    async with session_scope() as session:
        assert (
            await session.execute(text("SELECT count(*) FROM external_events"))
        ).scalar_one() == 0
