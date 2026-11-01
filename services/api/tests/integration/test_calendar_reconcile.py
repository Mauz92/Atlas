"""Periodic reconciliation fallback against the fake adapter and a real PostgreSQL (M5-10).

These are the load-bearing tests for the reconciliation safety net (AGENTS.md §10;
``CALENDAR_SYNC.md`` §3/§9): a change whose provider notification was lost/never delivered is
recovered by the next scan from the stored cursor; the scan is idempotent; an interrupted run
neither loses nor duplicates work (the durable queue reschedules it and the idempotent projection
re-applies nothing twice); the durable ``in_progress`` marker is set while a run is underway and
cleared afterwards, and the M5-08 status read reports it; the M5-06 cursor rule is preserved (a
failing scan never advances the cursor); and every query is user-scoped. No provider is contacted —
the adapter is the M5-02 :class:`~atlas.calendar.fake.FakeCalendarAdapter` over the registry seam.
"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable, Sequence
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select

from atlas.calendar import (
    AdapterRegistry,
    Calendar,
    CalendarReconciliationService,
    Event,
    EventPage,
    FakeCalendarAdapter,
    ProviderCredentialsService,
    SyncState,
    SyncStatusService,
    TokenBundle,
    TransientProviderError,
)
from atlas.db import session_scope
from atlas.jobs import queue, worker
from atlas.jobs.handlers import (
    CALENDAR_RECONCILE_TASK,
    RECONCILE_TASK,
    ensure_calendar_reconcile_job,
    ensure_recurring_jobs,
)
from atlas.models import ExternalEvent, Job, JobStatus, SyncCursor, User

pytestmark = pytest.mark.usefixtures("_db")

PROVIDER = "google"
CALENDAR_ID = "cal-primary"
UPDATED = datetime(2026, 10, 27, 8, 0, tzinfo=UTC)


def _event(event_id: str, *, updated: datetime = UPDATED) -> Event:
    start = datetime(2026, 10, 27, 9, 0, tzinfo=UTC)
    return Event(
        id=event_id,
        calendar_id=CALENDAR_ID,
        provider=PROVIDER,
        summary=f"Event {event_id}",
        start=start,
        end=start + timedelta(hours=1),
        time_zone="Europe/Berlin",
        updated=updated,
    )


def _fake(*event_ids: str, page_size: int = 100) -> FakeCalendarAdapter:
    adapter = FakeCalendarAdapter(provider=PROVIDER, page_size=page_size)
    adapter.add_calendar(
        Calendar(id=CALENDAR_ID, provider=PROVIDER, name="Primary", time_zone="Europe/Berlin")
    )
    for event_id in event_ids:
        adapter.add_event(_event(event_id))
    return adapter


def _registry(adapter) -> AdapterRegistry:
    registry = AdapterRegistry()
    registry.register(PROVIDER, lambda _credential: adapter, replace=True)
    return registry


async def _account(access_token: str = "token-a") -> uuid.UUID:
    """Create a user with a stored credential for ``PROVIDER`` (an encrypted real row)."""
    async with session_scope() as session:
        user = User(email=f"{uuid.uuid4()}@example.com", display_name="Owner", password_hash="x")
        session.add(user)
        await session.flush()
        user_id = user.id
        await ProviderCredentialsService(session, user_id).upsert(
            PROVIDER, tokens=TokenBundle(access_token=access_token)
        )
    return user_id


async def _scan(registry: AdapterRegistry, **kwargs):
    async with session_scope() as session:
        return await CalendarReconciliationService(session, registry=registry).scan(**kwargs)


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


async def _cursor(user_id: uuid.UUID) -> SyncCursor | None:
    async with session_scope() as session:
        return await session.scalar(
            select(SyncCursor).where(
                SyncCursor.user_id == user_id,
                SyncCursor.provider == PROVIDER,
                SyncCursor.calendar_id == CALENDAR_ID,
            )
        )


async def _projection_count() -> int:
    async with session_scope() as session:
        return await session.scalar(select(func.count()).select_from(ExternalEvent)) or 0


# --- the missed-notification recovery --------------------------------------


async def test_a_scan_recovers_a_change_no_notification_delivered() -> None:
    user_id = await _account()
    fake = _fake("e0", "e1")
    registry = _registry(fake)

    first = await _scan(registry)
    assert first.synced == 1
    assert set(await _projections(user_id)) == {"e0", "e1"}
    cursor_before = (await _cursor(user_id)).cursor_value

    # A change happens at the provider but no notification reaches Atlas (a hint that was lost).
    fake.add_event(_event("e2"))

    second = await _scan(registry, interval_seconds=0)
    assert second.synced == 1
    # The scan re-synced from the stored cursor and recovered exactly the missed change.
    assert set(await _projections(user_id)) == {"e0", "e1", "e2"}
    assert (await _cursor(user_id)).cursor_value != cursor_before


async def test_a_scan_recovers_a_deletion_no_notification_delivered() -> None:
    user_id = await _account()
    fake = _fake("e0")
    registry = _registry(fake)
    await _scan(registry)

    fake.delete_event("e0", CALENDAR_ID)  # no notification delivered
    await _scan(registry, interval_seconds=0)

    projections = await _projections(user_id)
    assert set(projections) == {"e0"}
    assert projections["e0"].deleted_at is not None  # tombstoned, never falsely lost


# --- idempotency -----------------------------------------------------------


async def test_a_scan_is_idempotent_and_never_duplicates() -> None:
    user_id = await _account()
    fake = _fake("e0", "e1")
    registry = _registry(fake)
    await _scan(registry)
    count_after_first = await _projection_count()

    second = await _scan(registry, interval_seconds=0)

    assert second.synced == 1
    assert second.calendars[0].created == 0
    assert await _projection_count() == count_after_first
    assert set(await _projections(user_id)) == {"e0", "e1"}


# --- the durable running marker + status read ------------------------------


class _MarkerObservingAdapter:
    """A fake wrapper that runs an async probe after the first page of a live pass."""

    def __init__(self, fake: FakeCalendarAdapter, on_first_page: Callable[[], Awaitable[None]]):
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
            await self._on_first_page()
        return page


async def test_the_running_marker_is_set_then_cleared_and_the_status_reports_in_progress() -> None:
    user_id = await _account()
    fake = _fake("e0")
    observed: dict[str, object] = {}

    async def probe() -> None:
        async with session_scope() as session:
            row = await session.scalar(
                select(SyncCursor).where(
                    SyncCursor.user_id == user_id,
                    SyncCursor.provider == PROVIDER,
                    SyncCursor.calendar_id == CALENDAR_ID,
                )
            )
            assert row is not None
            observed["sync_started_at"] = row.sync_started_at
            statuses = await SyncStatusService(session, user_id).status()
        observed["state"] = statuses[0].calendars[0].state
        observed["in_progress"] = statuses[0].calendars[0].in_progress

    registry = _registry(_MarkerObservingAdapter(fake, probe))
    summary = await _scan(registry)

    assert summary.synced == 1
    # While the pass was in flight the durable marker was set and the status read it as in_progress.
    assert observed["sync_started_at"] is not None
    assert observed["state"] is SyncState.IN_PROGRESS
    assert observed["in_progress"] is True

    # Once the run ended the marker is cleared and the status is idle (a real successful outcome).
    cursor = await _cursor(user_id)
    assert cursor is not None
    assert cursor.sync_started_at is None
    async with session_scope() as session:
        statuses = await SyncStatusService(session, user_id).status()
    assert statuses[0].calendars[0].state is SyncState.IDLE
    assert statuses[0].calendars[0].in_progress is False


async def test_a_stale_marker_is_not_reported_as_in_progress() -> None:
    user_id = await _account()
    fake = _fake("e0")
    await _scan(_registry(fake))

    # Simulate a run that crashed without clearing its marker (past the freshness window).
    async with session_scope() as session:
        row = await session.scalar(select(SyncCursor).where(SyncCursor.user_id == user_id))
        assert row is not None
        row.sync_started_at = datetime.now(UTC) - timedelta(days=2)

    async with session_scope() as session:
        statuses = await SyncStatusService(session, user_id).status()
    assert statuses[0].calendars[0].state is SyncState.IDLE  # never claims a run it cannot prove
    assert statuses[0].calendars[0].in_progress is False


# --- the cursor rule is preserved (a scan never substitutes for the cursor) --


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


async def test_a_failing_scan_leaves_the_cursor_unchanged_and_clears_the_marker() -> None:
    user_id = await _account()
    fake = _fake("e0")
    await _scan(_registry(fake))
    cursor_before = (await _cursor(user_id)).cursor_value
    assert cursor_before is not None

    failing = _FailingAdapter(fake)
    failing.armed = True
    summary = await _scan(_registry(failing), interval_seconds=0)

    assert summary.failed == 1
    cursor = await _cursor(user_id)
    assert cursor is not None
    assert cursor.cursor_value == cursor_before  # never advanced by a failed scan
    assert cursor.last_error is not None
    assert cursor.sync_started_at is None  # the marker is cleared even on failure

    # Recovery: the change is applied on the next successful scan — nothing was skipped.
    failing.armed = False
    fake.add_event(_event("e1"))
    recovered = await _scan(_registry(failing), interval_seconds=0)
    assert recovered.synced == 1
    assert set(await _projections(user_id)) == {"e0", "e1"}
    assert (await _cursor(user_id)).last_error is None


# --- restart safety --------------------------------------------------------


async def test_a_stale_marker_makes_the_calendar_due_so_an_interrupted_run_recovers() -> None:
    user_id = await _account()
    fake = _fake("e0")
    registry = _registry(fake)
    await _scan(registry)

    # A run started and was interrupted: the marker is left stale and a change arrived meanwhile.
    async with session_scope() as session:
        row = await session.scalar(select(SyncCursor).where(SyncCursor.user_id == user_id))
        assert row is not None
        row.sync_started_at = datetime.now(UTC) - timedelta(seconds=100_000)
    fake.add_event(_event("e1"))

    # The default interval would not yet be due, but the stale marker forces a recovery scan.
    summary = await _scan(registry)

    assert summary.synced == 1
    assert set(await _projections(user_id)) == {"e0", "e1"}
    assert (await _cursor(user_id)).sync_started_at is None


async def test_ensure_recurring_jobs_starts_the_calendar_scan_chain() -> None:
    async with session_scope() as session:
        await ensure_recurring_jobs(session)

    async with session_scope() as session:
        tasks = set(
            await session.scalars(
                select(Job.task_name).where(Job.status == JobStatus.PENDING.value)
            )
        )
    assert {RECONCILE_TASK, CALENDAR_RECONCILE_TASK} <= tasks


async def test_the_worker_processes_the_calendar_scan_and_reschedules_it() -> None:
    async with session_scope() as session:
        await queue.enqueue(session, CALENDAR_RECONCILE_TASK)

    assert await worker.run_once("worker-1") is True

    async with session_scope() as session:
        rescheduled = await session.scalar(
            select(Job).where(
                Job.task_name == CALENDAR_RECONCILE_TASK,
                Job.status == JobStatus.PENDING.value,
            )
        )
    assert rescheduled is not None  # the next scan is durable


async def _run_job(job_id: uuid.UUID) -> Job:
    async with session_scope() as session:
        job = await session.get(Job, job_id)
        assert job is not None
        return job


async def test_ensure_reaps_a_stale_running_scan_and_schedules_a_fresh_one() -> None:
    async with session_scope() as session:
        job = await queue.enqueue(session, CALENDAR_RECONCILE_TASK)
        job.status = JobStatus.RUNNING.value
        job.locked_by = "dead-worker"
        job.locked_at = datetime.now(UTC) - timedelta(seconds=100_000)
        job_id = job.id
        await session.flush()

    async with session_scope() as session:
        await ensure_calendar_reconcile_job(session)

    stale = await _run_job(job_id)
    assert stale.status == JobStatus.FAILED.value
    async with session_scope() as session:
        fresh = await session.scalar(
            select(Job).where(
                Job.task_name == CALENDAR_RECONCILE_TASK,
                Job.status == JobStatus.PENDING.value,
            )
        )
    assert fresh is not None


async def test_ensure_leaves_a_live_running_scan_alone() -> None:
    async with session_scope() as session:
        job = await queue.enqueue(session, CALENDAR_RECONCILE_TASK)
        job.status = JobStatus.RUNNING.value
        job.locked_by = "live-worker"
        job.locked_at = datetime.now(UTC)
        job_id = job.id
        await session.flush()

    async with session_scope() as session:
        await ensure_calendar_reconcile_job(session)

    assert (await _run_job(job_id)).status == JobStatus.RUNNING.value
    async with session_scope() as session:
        pending = await session.scalar(
            select(func.count())
            .select_from(Job)
            .where(
                Job.task_name == CALENDAR_RECONCILE_TASK,
                Job.status == JobStatus.PENDING.value,
            )
        )
    assert pending == 0


async def test_ensure_does_not_double_schedule_a_queued_scan() -> None:
    async with session_scope() as session:
        await queue.enqueue(session, CALENDAR_RECONCILE_TASK)

    async with session_scope() as session:
        await ensure_calendar_reconcile_job(session)

    async with session_scope() as session:
        total = await session.scalar(
            select(func.count()).select_from(Job).where(Job.task_name == CALENDAR_RECONCILE_TASK)
        )
    assert total == 1


# --- user scoping ----------------------------------------------------------


async def test_a_scan_is_strictly_user_scoped() -> None:
    alice = await _account("token-alice")
    bob = await _account("token-bob")
    fakes = {"token-alice": _fake("a0", "a1"), "token-bob": _fake("b0")}
    registry = AdapterRegistry()
    registry.register(
        PROVIDER, lambda credential: fakes[credential.tokens.access_token or ""], replace=True
    )

    summary = await _scan(registry)

    assert summary.accounts == 2
    assert set(await _projections(alice)) == {"a0", "a1"}
    assert set(await _projections(bob)) == {"b0"}

    alice_cursor = await _cursor(alice)
    bob_cursor = await _cursor(bob)
    assert alice_cursor is not None and bob_cursor is not None
    assert alice_cursor.user_id == alice
    assert bob_cursor.user_id == bob
    assert alice_cursor.id != bob_cursor.id


# --- boundary: no adapter / no account -------------------------------------


async def test_a_scan_without_an_adapter_is_a_harmless_no_op() -> None:
    # A connected provider whose adapter does not exist yet (M5-03/M5-04 pending M5-00/AR-001).
    await _account()
    empty = AdapterRegistry()  # no factory registered

    summary = await _scan(empty)

    assert summary.accounts == 1
    assert summary.unavailable == 1
    assert summary.synced == 0
    assert await _projection_count() == 0


async def test_a_scan_with_nothing_connected_does_nothing() -> None:
    summary = await _scan(AdapterRegistry())
    assert summary.accounts == 0
    assert summary.calendars == ()
