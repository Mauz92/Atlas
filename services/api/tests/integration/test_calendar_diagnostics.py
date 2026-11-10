"""``atlas-admin calendar-status`` is read-only and prints no secret or personal content."""

from __future__ import annotations

import pytest

from atlas.calendar.diagnostics import render_calendar_status
from atlas.db import session_scope
from tests.fakes.calendar_provider import PROVIDER
from tests.integration.test_calendar_oauth_api import _connect, _login

pytestmark = pytest.mark.usefixtures("_db")

SECRET = "FEEDSECRET5544"


async def test_calendar_status_reports_state_without_secrets(client, fake_provider) -> None:
    headers = await _login(client)
    await _connect(client, headers)
    PROVIDER.set_ics(
        f"{SECRET}.ics",
        "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:1\r\nDTSTART:20261110T090000Z\r\nSUMMARY:Private title\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
    )
    await client.post(
        "/api/calendar/feeds",
        json={"url": f"http://127.0.0.1:9911/ics/{SECRET}.ics", "name": "Private feed name"},
        headers=headers,
    )
    await client.post("/api/calendar/providers/ics/sync", headers=headers)
    async with session_scope() as session:
        text = "\n".join(await render_calendar_status(session))
    assert "google: connected" in text and "ics: 1 feed(s)" in text and "events=1" in text
    assert "redirect URI https://atlas.example.test/api/calendar/google/callback" in text
    secrets = [
        SECRET,
        "Private title",
        "Private feed name",
        "owner@example.test",
        *PROVIDER.refresh_tokens,
        *PROVIDER.access_tokens,
    ]
    assert all(s not in text for s in secrets)
