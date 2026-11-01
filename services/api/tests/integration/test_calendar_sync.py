"""Calendar sync against the fake adapter and a real PostgreSQL (M5-06).

These are the load-bearing tests for the cursor-safety rule (``CALENDAR_SYNC.md`` §4, AGENTS.md
§10): the projection is applied and the cursor advanced in one committed transaction, a failure
between apply and commit leaves the cursor unchanged and re-syncs skip nothing, re-sync is
idempotent, and every query is user-scoped. The adapter is the M5-02
:class:`~atlas.calendar.fake.FakeCalendarAdapter` (injected directly); no provider is contacted.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Sequence
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import event, func, select
from sqlalchemy.orm import Session

from atlas.calendar import (
    Calendar,
    CalendarSyncService,
    Event,
    EventPage,
    FakeCalendarAdapter,
    TransientProviderError,
)
from atlas.db import session_scope
from atlas.models import ExternalEvent, SyncCursor, User

pytestmark = pytest.mark.usefixtures("_db")

PROVIDER = "google"
CALENDAR_ID = "cal-primary"
UPDATED = datetime(2026, 10, 27, 8, 0, tzinfo=UTC)


def _event(
    event_id: str,
    *,
    summary: str | None = None,
    etag: str | None = None,
    hour: int = 9,
    updated: datetime | None = None,
) -> Event:
    start = datetime(2026, 10, 27, hour, 0, tzinfo=UTC)
    return Event(
        id=event_id,
        calendar_id=CALENDAR_ID,
        provider=PROVIDER,
        summary=summary if summary is not None else f"Event {event_id}",
        start=start,
        end=start + timedelta(hours=1),
        time_zone="Europe/Berlin",
        updated=updated if updated is not None else UPDATED,
        etag=etag if etag is not None else None,
    )


def _adapter(*event_ids: str, page_size: int = 100) -> FakeCalendarAdapter:
    adapter = FakeCalendarAdapter(provider=PROVIDER, page_size=page_size)
    adapter.add_calendar(
        Calendar(id=CALENDAR_ID, provider=PROVIDER, name="Primary", time_zone="Europe/Berlin")
    )
    for event_id in event_ids:
        adapter.add_event(_event(event_id))
    return adapter


async def _create_user(session) -> uuid.UUID:
    user = User(
        email=f"{uuid.uuid4()}@example.com",
        display_name="Owner",
        password_hash="not-used-by-sync-tests",
    )
    session.add(user)
    await session.flush()
    return user.id


async def _new_user() -> uuid.UUID:
    async with session_scope() as session:
        return await _create_user(session)


async def _sync(user_id: uuid.UUID, adapter, *, page_size: int | None = None):
    async with session_scope() as session:
        service = CalendarSyncService(session, user_id)
        return await service.sync_calendar(adapter, CALENDAR_ID, page_size=page_size)


async def _projections(user_id: uuid.UUID, provider: str = PROVIDER) -> dict[str, ExternalEvent]:
    async with session_scope() as session:
        rows = (
            await session.execute(
                select(ExternalEvent).where(
                    ExternalEvent.user_id == user_id, ExternalEvent.provider == provider
                )
            )
        ).scalars()
        return {row.external_event_id: row for row in rows}


async def _cursor(user_id: uuid.UUID, provider: str = PROVIDER) -> SyncCursor | None:
    async with session_scope() as session:
        return await session.scalar(
            select(SyncCursor).where(
                SyncCursor.user_id == user_id,
                SyncCursor.provider == provider,
                SyncCursor.calendar_id == CALENDAR_ID,
            )
        )


async def _force_cursor(user_id: uuid.UUID, value: str | None) -> None:
    """Rewrite the stored cursor value, to model a re-baseline in the idempotency test."""
    async with session_scope() as session:
        row = await session.scalar(
            select(SyncCursor).where(
                SyncCursor.user_id == user_id, SyncCursor.calendar_id == CALENDAR_ID
            )
        )
        assert row is not None
        row.cursor_value = value


class _PausingAdapter:
    """A fake adapter wrapper that runs a one-shot side effect after the first page of a pass."""

    def __init__(self, fake: FakeCalendarAdapter, on_first_page: Callable[[], None]) -> None:
        self._fake = fake
        self._on_first_page = on_first_page
        self._fired = False
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
        page = await self._fake.list_events(
            calendar_id, cursor=cursor, page_token=page_token, page_size=page_size
        )
        if page_token is None and not self._fired:
            self._fired = True
            self._on_first_page()
        return page


class _FailingAdapter:
    """A fake adapter wrapper that raises a provider error while armed (and delegates otherwise)."""

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


# --- first sync / baseline -------------------------------------------------


async def test_first_sync_establishes_a_baseline_and_records_the_cursor() -> None:
    user_id = await _new_user()
    adapter = _adapter("e0", "e1", "e2")

    result = await _sync(user_id, adapter)

    assert result.cursor_before is None
    assert result.cursor_after == adapter.current_cursor()
    assert result.created == 3
    assert result.events_seen == 3
    assert result.pages >= 1

    projections = await _projections(user_id)
    assert set(projections) == {"e0", "e1", "e2"}
    assert all(row.deleted_at is None for row in projections.values())

    cursor = await _cursor(user_id)
    assert cursor is not None
    assert cursor.cursor_value == adapter.current_cursor()
    assert cursor.cursor_type == "sync_token"
    assert cursor.last_success_at is not None
    assert cursor.last_error is None


# --- incremental sync ------------------------------------------------------


async def test_incremental_sync_returns_only_changes_since_the_cursor() -> None:
    user_id = await _new_user()
    adapter = _adapter("e0", "e1")
    await _sync(user_id, adapter)

    adapter.update_event(
        _event(
            "e0", summary="Renamed", etag="etag-v2", hour=11, updated=UPDATED + timedelta(minutes=5)
        )
    )
    adapter.add_event(_event("e2"))
    adapter.delete_event("e1", CALENDAR_ID)

    result = await _sync(user_id, adapter)

    assert result.events_seen == 2  # only e0 (changed) and e2 (created)
    assert result.deletions_seen == 1
    assert result.created == 1
    assert result.updated == 1
    assert result.unchanged == 0
    assert result.tombstoned == 1

    projections = await _projections(user_id)
    assert set(projections) == {"e0", "e1", "e2"}
    assert projections["e0"].summary == "Renamed"
    assert projections["e1"].deleted_at is not None  # tombstoned, not deleted
    assert projections["e2"].deleted_at is None


async def test_a_deletion_becomes_a_tombstone_and_never_loses_the_row() -> None:
    user_id = await _new_user()
    adapter = _adapter("e0")
    await _sync(user_id, adapter)
    before = (await _projections(user_id))["e0"]
    assert before.summary == "Event e0"

    adapter.delete_event("e0", CALENDAR_ID)
    result = await _sync(user_id, adapter)

    assert result.tombstoned == 1
    projections = await _projections(user_id)
    assert set(projections) == {"e0"}  # the row is retained
    assert projections["e0"].deleted_at is not None
    assert projections["e0"].summary == "Event e0"  # last-known fields preserved


async def test_a_tombstoned_event_is_revived_when_it_reappears() -> None:
    user_id = await _new_user()
    adapter = _adapter("e0")
    await _sync(user_id, adapter)
    adapter.delete_event("e0", CALENDAR_ID)
    await _sync(user_id, adapter)

    adapter.add_event(_event("e0", summary="Back again", etag="etag-v2"))
    result = await _sync(user_id, adapter)

    assert result.updated == 1
    projections = await _projections(user_id)
    assert projections["e0"].deleted_at is None
    assert projections["e0"].summary == "Back again"


# --- idempotency -----------------------------------------------------------


async def test_re_sync_is_idempotent_with_no_duplicate_projections() -> None:
    user_id = await _new_user()
    adapter = _adapter("e0", "e1")
    await _sync(user_id, adapter)

    # Model a re-baseline: drop the cursor value so the same full listing is re-applied.
    await _force_cursor(user_id, None)
    result = await _sync(user_id, adapter)

    assert result.created == 0
    assert result.unchanged == 2
    projections = await _projections(user_id)
    assert set(projections) == {"e0", "e1"}  # no duplicates, no IntegrityError
    cursor = await _cursor(user_id)
    assert cursor is not None
    assert cursor.cursor_value == adapter.current_cursor()


# --- cursor safety ---------------------------------------------------------


async def test_a_failure_between_apply_and_commit_leaves_the_cursor_unchanged() -> None:
    user_id = await _new_user()
    adapter = _adapter("e0")
    await _sync(user_id, adapter)
    cursor_after_baseline = (await _cursor(user_id)).cursor_value
    assert cursor_after_baseline is not None

    adapter.add_event(_event("e1"))  # a change the next pass must apply

    fired = {"count": 0}

    def _crash_before_commit(session: Session) -> None:
        fired["count"] += 1
        if fired["count"] == 1:
            raise RuntimeError("simulated crash after apply, before commit")

    from atlas.db import get_session_factory

    factory = get_session_factory()
    async with factory() as session:
        service = CalendarSyncService(session, user_id)
        event.listen(session.sync_session, "before_commit", _crash_before_commit)
        try:
            with pytest.raises(RuntimeError, match="simulated crash"):
                await service.sync_calendar(adapter, CALENDAR_ID)
        finally:
            event.remove(session.sync_session, "before_commit", _crash_before_commit)

    # The applied change was rolled back and, crucially, the cursor did not move.
    assert set(await _projections(user_id)) == {"e0"}
    cursor = await _cursor(user_id)
    assert cursor is not None
    assert cursor.cursor_value == cursor_after_baseline
    assert cursor.last_error is not None  # the failure is recorded for sync status

    # Re-syncing from the unchanged cursor still applies the change: nothing was skipped.
    result = await _sync(user_id, adapter)
    assert result.created == 1
    assert set(await _projections(user_id)) == {"e0", "e1"}
    assert (await _cursor(user_id)).cursor_value != cursor_after_baseline


async def test_a_fetch_failure_records_the_error_and_leaves_the_cursor_unchanged() -> None:
    user_id = await _new_user()
    fake = _adapter("e0")
    await _sync(user_id, fake)
    cursor_after_baseline = (await _cursor(user_id)).cursor_value

    failing = _FailingAdapter(fake)
    failing.armed = True
    with pytest.raises(TransientProviderError):
        await _sync(user_id, failing)

    cursor = await _cursor(user_id)
    assert cursor is not None
    assert cursor.cursor_value == cursor_after_baseline  # unchanged
    assert cursor.last_error is not None
    assert set(await _projections(user_id)) == {"e0"}

    failing.armed = False
    await _sync(user_id, failing)  # recovers
    assert (await _cursor(user_id)).last_error is None


async def test_cursor_advances_only_on_the_final_page_and_defers_a_mid_page_change() -> None:
    user_id = await _new_user()
    fake = _adapter("e0", "e1", "e2", "e3", page_size=2)
    cursor_before_change = fake.current_cursor()

    def _add_mid_pass() -> None:
        fake.add_event(_event("e4"))  # lands while the caller is between pages

    adapter = _PausingAdapter(fake, _add_mid_pass)
    result = await _sync(user_id, adapter, page_size=2)

    assert result.pages == 2  # the pass really did paginate
    # The cursor is the revision the pass started at, so the mid-pass change is deferred...
    assert result.cursor_after == cursor_before_change
    assert result.cursor_after != fake.current_cursor()
    assert set(await _projections(user_id)) == {"e0", "e1", "e2", "e3"}

    # ...and the very next pass picks it up — it was deferred, never skipped.
    second = await _sync(user_id, fake)
    assert second.created == 1
    assert set(await _projections(user_id)) == {"e0", "e1", "e2", "e3", "e4"}


# --- user scoping ----------------------------------------------------------


async def test_projections_and_cursors_are_strictly_user_scoped() -> None:
    alice = await _new_user()
    bob = await _new_user()
    adapter_a = _adapter("a0", "a1")
    adapter_b = _adapter("b0")

    await _sync(alice, adapter_a)
    await _sync(bob, adapter_b)

    assert set(await _projections(alice)) == {"a0", "a1"}
    assert set(await _projections(bob)) == {"b0"}

    async with session_scope() as session:
        alice_rows = (
            await session.execute(select(ExternalEvent).where(ExternalEvent.user_id == alice))
        ).scalars()
        assert {row.external_event_id for row in alice_rows} == {"a0", "a1"}
        total = await session.scalar(select(func.count()).select_from(ExternalEvent))
        assert total == 3  # each user's rows are their own

    alice_cursor = await _cursor(alice)
    bob_cursor = await _cursor(bob)
    assert alice_cursor is not None and bob_cursor is not None
    assert alice_cursor.id != bob_cursor.id
    assert alice_cursor.user_id == alice
    assert bob_cursor.user_id == bob
