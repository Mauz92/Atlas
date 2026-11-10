"""Calendar sync status + manual trigger over HTTP against a real PostgreSQL (M5-08).

End-to-end: the status is derived from the M5-06 cursor rows after a *successful* sync, after a
*failed* sync (a safe, content-free message), and before anything is connected (empty); the manual
trigger reuses the M5-06 service over the M5-02 registry seam (the in-memory fake — **no provider is
contacted**), is idempotent, and is strictly user-scoped. Secrets never appear in any response.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI
from sqlalchemy import func, select

from atlas.api.calendar import get_adapter_registry
from atlas.calendar import (
    AdapterRegistry,
    Calendar,
    Event,
    EventPage,
    FakeCalendarAdapter,
    TransientProviderError,
    fake_adapter_factory,
)
from atlas.db import session_scope
from atlas.models import ExternalEvent, SyncCursor, User
from tests.conftest import create_user_via_setup, csrf_headers

pytestmark = pytest.mark.usefixtures("_db")

ACCESS = "ya29.SUPERSECRETACCESS"
REFRESH = "1//SUPERSECRETREFRESH"
PROVIDER = "google"
CALENDAR_ID = "cal-primary"
UPDATED = datetime(2026, 10, 27, 8, 0, tzinfo=UTC)


def _event(event_id: str) -> Event:
    start = datetime(2026, 10, 27, 9, 0, tzinfo=UTC)
    return Event(
        id=event_id,
        calendar_id=CALENDAR_ID,
        provider=PROVIDER,
        summary=f"Event {event_id}",
        start=start,
        end=start + timedelta(hours=1),
        time_zone="Europe/Berlin",
        updated=UPDATED,
    )


def _fake(*event_ids: str) -> FakeCalendarAdapter:
    adapter = FakeCalendarAdapter(provider=PROVIDER)
    adapter.add_calendar(
        Calendar(id=CALENDAR_ID, provider=PROVIDER, name="Primary", time_zone="Europe/Berlin")
    )
    for event_id in event_ids:
        adapter.add_event(_event(event_id))
    return adapter


def _registry(fake) -> AdapterRegistry:
    registry = AdapterRegistry()
    registry.register(PROVIDER, fake_adapter_factory(fake), replace=True)
    return registry


class _FailingAdapter:
    """A fake wrapper that raises a provider error while armed (and delegates otherwise)."""

    def __init__(self, fake: FakeCalendarAdapter) -> None:
        self._fake = fake
        self.armed = False
        self.provider = fake.provider
        self.cursor_type = fake.cursor_type

    async def list_calendars(self) -> Sequence[Calendar]:
        return await self._fake.list_calendars()

    async def list_events(
        self,
        calendar_id: str,
        *,
        cursor: str | None = None,
        page_token: str | None = None,
        page_size: int | None = None,
    ) -> EventPage:
        if self.armed:
            raise TransientProviderError("simulated provider outage", provider=self.provider)
        return await self._fake.list_events(
            calendar_id, cursor=cursor, page_token=page_token, page_size=page_size
        )


@contextmanager
def _use_registry(app: FastAPI, registry: AdapterRegistry) -> Iterator[None]:
    app.dependency_overrides[get_adapter_registry] = lambda: registry
    try:
        yield
    finally:
        app.dependency_overrides.pop(get_adapter_registry, None)


async def _auth(client) -> dict[str, str]:
    await create_user_via_setup(client)
    return csrf_headers(client)


async def _connect(client, headers: dict[str, str]) -> None:
    response = await client.put(
        "/api/calendar/credentials/google",
        json={"access_token": ACCESS, "refresh_token": REFRESH, "scopes": ["calendar.readonly"]},
        headers=headers,
    )
    assert response.status_code == 200, response.text


async def _add_other_user_cursor() -> uuid.UUID:
    """Insert a foreign user with a cursor row, to prove the read is scoped to the caller."""
    async with session_scope() as session:
        other = User(
            id=uuid.uuid4(),
            email=f"{uuid.uuid4()}@example.com",
            display_name="Other",
            password_hash="not-used",
        )
        session.add(other)
        await session.flush()
        session.add(
            SyncCursor(
                user_id=other.id,
                provider=PROVIDER,
                calendar_id="other-cal",
                cursor_type="sync_token",
                cursor_value="rev:9",
                last_success_at=datetime(2026, 10, 27, 7, 0, tzinfo=UTC),
            )
        )
        await session.flush()
        return other.id


async def _external_event_count() -> int:
    async with session_scope() as session:
        return await session.scalar(select(func.count()).select_from(ExternalEvent)) or 0


# --- authentication / empty state -----------------------------------------


async def test_status_and_trigger_require_authentication(client) -> None:
    assert (await client.get("/api/calendar/sync-status")).status_code == 401
    assert (await client.post("/api/calendar/providers/google/sync")).status_code == 401


async def test_trigger_requires_csrf(client) -> None:
    await create_user_via_setup(client)
    response = await client.post("/api/calendar/providers/google/sync")
    assert response.status_code == 403


async def test_status_is_empty_before_anything_is_connected(client) -> None:
    await _auth(client)
    response = await client.get("/api/calendar/sync-status")
    assert response.status_code == 200
    assert response.json() == {"providers": []}


async def test_a_connected_provider_without_a_sync_is_never_synced(client) -> None:
    headers = await _auth(client)
    await _connect(client, headers)

    body = (await client.get("/api/calendar/sync-status")).json()
    assert len(body["providers"]) == 1
    provider = body["providers"][0]
    assert provider["provider"] == "google"
    assert provider["connected"] is True
    assert provider["state"] == "never_synced"
    assert provider["last_success_at"] is None
    assert provider["last_error"] is None
    assert provider["calendars"] == []


# --- successful sync -------------------------------------------------------


async def test_status_reflects_a_successful_sync(client, app: FastAPI) -> None:
    headers = await _auth(client)
    await _connect(client, headers)

    fake = _fake("e0", "e1")
    with _use_registry(app, _registry(fake)):
        synced = await client.post("/api/calendar/providers/google/sync", headers=headers)
    assert synced.status_code == 200, synced.text
    outcome = synced.json()
    assert outcome["provider"] == "google"
    assert len(outcome["calendars"]) == 1
    calendar = outcome["calendars"][0]
    assert calendar["calendar_id"] == CALENDAR_ID
    assert calendar["created"] == 2
    assert calendar["events_seen"] == 2
    assert calendar["cursor_advanced"] is True
    # The response never carries the opaque cursor value or any event content.
    assert "rev:" not in synced.text
    assert "Event e0" not in synced.text

    body = (await client.get("/api/calendar/sync-status")).json()
    provider = body["providers"][0]
    assert provider["state"] == "idle"
    assert provider["connected"] is True
    assert provider["last_error"] is None
    assert provider["last_success_at"] is not None
    detail = provider["calendars"][0]
    assert detail["calendar_id"] == CALENDAR_ID
    assert detail["state"] == "idle"
    assert detail["cursor_health"] == "ok"
    assert detail["cursor_type"] == "sync_token"
    assert detail["has_cursor"] is True
    assert detail["last_error"] is None
    assert "rev:" not in (await client.get("/api/calendar/sync-status")).text


async def _force_cursor_none(calendar_id: str) -> None:
    """Drop the stored cursor value, to model a re-baseline and exercise re-application."""
    async with session_scope() as session:
        row = await session.scalar(
            select(SyncCursor).where(
                SyncCursor.provider == PROVIDER, SyncCursor.calendar_id == calendar_id
            )
        )
        assert row is not None
        row.cursor_value = None


async def test_manual_sync_is_idempotent(client, app: FastAPI) -> None:
    headers = await _auth(client)
    await _connect(client, headers)
    fake = _fake("e0")

    with _use_registry(app, _registry(fake)):
        first = await client.post("/api/calendar/providers/google/sync", headers=headers)
    assert first.status_code == 200
    assert first.json()["calendars"][0]["created"] == 1

    # A re-baseline re-applies the same change; it must be a no-op, never a duplicate.
    await _force_cursor_none(CALENDAR_ID)
    with _use_registry(app, _registry(fake)):
        second = await client.post("/api/calendar/providers/google/sync", headers=headers)
    assert second.status_code == 200
    assert second.json()["calendars"][0]["created"] == 0
    assert second.json()["calendars"][0]["unchanged"] == 1
    assert await _external_event_count() == 1


# --- error state + secret safety ------------------------------------------


async def test_error_state_records_a_safe_message_and_leaks_no_secret(client, app: FastAPI) -> None:
    headers = await _auth(client)
    await _connect(client, headers)

    fake = _fake("e0")
    failing = _FailingAdapter(fake)
    failing.armed = True
    registry = AdapterRegistry()
    registry.register(PROVIDER, lambda _credential: failing, replace=True)

    with _use_registry(app, registry):
        failed = await client.post("/api/calendar/providers/google/sync", headers=headers)

    assert failed.status_code == 502
    assert failed.json()["detail"] == "simulated provider outage"
    # No token, ciphertext or cursor value in the failure response.
    assert ACCESS not in failed.text
    assert REFRESH not in failed.text

    status = await client.get("/api/calendar/sync-status")
    assert status.status_code == 200
    provider = status.json()["providers"][0]
    assert provider["state"] == "error"
    assert provider["last_error"] == "simulated provider outage"
    assert provider["last_error_at"] is not None
    detail = provider["calendars"][0]
    assert detail["state"] == "error"
    assert detail["cursor_health"] == "error"
    assert detail["has_cursor"] is False
    # The status response leaks nothing sensitive either.
    assert ACCESS not in status.text
    assert REFRESH not in status.text
    assert "ciphertext" not in status.text
    assert "rev:" not in status.text


# --- scoping / validation --------------------------------------------------


async def test_status_is_strictly_user_scoped(client, app: FastAPI) -> None:
    headers = await _auth(client)
    await _connect(client, headers)
    fake = _fake("e0")
    with _use_registry(app, _registry(fake)):
        await client.post("/api/calendar/providers/google/sync", headers=headers)

    await _add_other_user_cursor()

    provider = (await client.get("/api/calendar/sync-status")).json()["providers"][0]
    # The other user's calendar is invisible; the caller sees only their own.
    assert [item["calendar_id"] for item in provider["calendars"]] == [CALENDAR_ID]

    async with session_scope() as session:
        total = await session.scalar(select(func.count()).select_from(SyncCursor))
    assert total == 2  # both rows exist; only the caller's is returned


async def test_manual_sync_rejects_an_unknown_provider(client) -> None:
    headers = await _auth(client)
    response = await client.post("/api/calendar/providers/dropbox/sync", headers=headers)
    assert response.status_code == 422


async def test_manual_sync_without_a_connection_is_a_conflict(client, app: FastAPI) -> None:
    headers = await _auth(client)
    fake = _fake("e0")
    with _use_registry(app, _registry(fake)):
        response = await client.post("/api/calendar/providers/google/sync", headers=headers)
    assert response.status_code == 409
    assert response.json()["detail"] == "provider is not connected"


async def test_manual_sync_without_an_adapter_is_unavailable(app, client) -> None:
    headers = await _auth(client)
    await _connect(client, headers)
    # A registry with no adapter for the provider (the real ones are registered by default since
    # M5-03/M5-04; this keeps the "no adapter" contract tested).
    with _use_registry(app, AdapterRegistry()):
        response = await client.post("/api/calendar/providers/google/sync", headers=headers)
    assert response.status_code == 503
    assert response.json()["detail"] == "calendar sync is not available for this provider"
