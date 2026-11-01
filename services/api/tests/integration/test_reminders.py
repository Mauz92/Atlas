"""Durable reminder scheduler against a real PostgreSQL (M8-01).

Covers the acceptance criteria: a reminder fires exactly once at the time-zone-correct instant; a
retry/restart does not deliver twice; a cancelled/completed/archived/soft-deleted entity is skipped;
editing a due date reschedules; the scheduler is durable (job-queue backed) and idempotent; and the
migration matches the models, applies and reverses. Needs a database (``_db``).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, time, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import create_engine, inspect, select

from atlas.config import get_settings
from atlas.db import Base, get_engine, session_scope
from atlas.jobs import (
    REMINDER_DELIVER_TASK,
    REMINDERS_SCAN_TASK,
    ensure_reminder_scan_job,
    queue,
    worker,
)
from atlas.models import Job, Reminder, ReminderDelivery, ReminderPolicy, ReminderStatus, Task, User
from atlas.reminders import (
    RecordingNotifier,
    ReminderService,
    deliver_reminder,
    ensure_delivery_job,
    reset_notifier,
    scan_reminders,
    set_notifier,
)
from atlas.reminders.schedule import ReminderRule, remind_at_for
from tests.conftest import create_user_via_setup, csrf_headers

pytestmark = pytest.mark.usefixtures("_db")

#: A future due date whose reminder can be computed deterministically (no wall-clock dependence).
_DUE = datetime(2026, 6, 10, 15, 0, tzinfo=UTC)  # 17:00 Europe/Amsterdam (CEST)
_DUE_REMIND = datetime(2026, 6, 10, 7, 0, tzinfo=UTC)  # 09:00 local on the due day


@pytest.fixture
def notifier() -> RecordingNotifier:
    recording = RecordingNotifier()
    set_notifier(recording)
    yield recording
    reset_notifier()


async def _seed_task(
    *,
    due_at: datetime = _DUE,
    status: str = "inbox",
    deleted: bool = False,
    time_zone: str | None = "Europe/Amsterdam",
    policy: bool = True,
    days_before: int = 0,
    at_time: time = time(9, 0),
) -> tuple[uuid.UUID, uuid.UUID]:
    """Create a user, an optional reminder policy and a task; return ``(user_id, task_id)``."""
    async with session_scope() as session:
        user = User(email=f"{uuid.uuid4()}@example.com", display_name="Owner", password_hash="x")
        session.add(user)
        await session.flush()
        policy_id = None
        if policy:
            row = ReminderPolicy(
                user_id=user.id, name="Default", days_before=days_before, at_time=at_time
            )
            session.add(row)
            await session.flush()
            policy_id = row.id
        task = Task(
            user_id=user.id,
            title="Water the plants",
            status=status,
            due_at=due_at,
            time_zone=time_zone,
            reminder_policy_id=policy_id,
            deleted_at=datetime.now(UTC) if deleted else None,
        )
        session.add(task)
        await session.flush()
        return user.id, task.id


async def _sync(user_id: uuid.UUID, task_id: uuid.UUID) -> Reminder | None:
    async with session_scope() as session:
        return await ReminderService(session, user_id).sync_for_task(task_id)


async def _get_reminder(task_id: uuid.UUID) -> Reminder | None:
    async with session_scope() as session:
        return await session.scalar(select(Reminder).where(Reminder.entity_id == task_id))


async def _set_status(task_id: uuid.UUID, status: str, *, deleted: bool = False) -> None:
    async with session_scope() as session:
        task = await session.get(Task, task_id)
        assert task is not None
        task.status = status
        task.deleted_at = datetime.now(UTC) if deleted else None


async def _queue_ready_reminder(task_id: uuid.UUID, user_id: uuid.UUID) -> uuid.UUID:
    """A scheduled reminder already past its fire time, with its durable delivery job queued."""
    async with session_scope() as session:
        reminder = Reminder(
            user_id=user_id,
            entity_type="task",
            entity_id=task_id,
            remind_at=datetime.now(UTC) - timedelta(minutes=5),
            status=ReminderStatus.SCHEDULED.value,
        )
        session.add(reminder)
        await session.flush()
        await ensure_delivery_job(session, reminder)
        return reminder.id


async def _deliveries(reminder_id: uuid.UUID) -> int:
    async with session_scope() as session:
        rows = await session.scalars(
            select(ReminderDelivery).where(ReminderDelivery.reminder_id == reminder_id)
        )
        return len(list(rows))


# --- migration agreement ------------------------------------------------------


async def test_migrations_match_models() -> None:
    engine = get_engine()

    def _diff(sync_connection):
        from alembic.autogenerate import compare_metadata
        from alembic.migration import MigrationContext

        context = MigrationContext.configure(sync_connection, opts={"compare_type": True})
        return compare_metadata(context, Base.metadata)

    async with engine.connect() as connection:
        diffs = await connection.run_sync(_diff)
    assert diffs == []


def test_migration_upgrade_and_downgrade_round_trip() -> None:
    from atlas.migrations import downgrade, upgrade

    engine = create_engine(get_settings().database_url, future=True)
    try:
        downgrade("c1a2b3d4e5f6")
        with engine.connect() as connection:
            names = set(inspect(connection).get_table_names())
        assert {"reminders", "reminder_policies", "reminder_deliveries"}.isdisjoint(names)
    finally:
        upgrade("head")
    with engine.connect() as connection:
        names = set(inspect(connection).get_table_names())
    engine.dispose()
    assert {"reminders", "reminder_policies", "reminder_deliveries"} <= names


# --- materialisation ----------------------------------------------------------


async def test_scheduling_materialises_the_reminder_and_its_durable_job() -> None:
    user_id, task_id = await _seed_task()
    reminder = await _sync(user_id, task_id)
    assert reminder is not None
    assert reminder.status == ReminderStatus.SCHEDULED.value
    assert reminder.remind_at == _DUE_REMIND

    async with session_scope() as session:
        job = await session.scalar(
            select(Job).where(
                Job.idempotency_key
                == f"{REMINDER_DELIVER_TASK}:{reminder.id}:{int(_DUE_REMIND.timestamp())}"
            )
        )
    assert job is not None
    assert job.status == "pending"
    assert job.run_at == _DUE_REMIND  # the durable job fires at the exact reminder instant


async def test_a_task_without_a_policy_has_no_reminder() -> None:
    user_id, task_id = await _seed_task(policy=False)
    assert await _sync(user_id, task_id) is None
    assert await _get_reminder(task_id) is None


# --- exactly-once delivery ----------------------------------------------------


async def test_a_reminder_fires_once_and_records_the_delivery(notifier: RecordingNotifier) -> None:
    user_id, task_id = await _seed_task()
    reminder_id = await _queue_ready_reminder(task_id, user_id)

    assert await worker.run_once("worker-1") is True

    async with session_scope() as session:
        reminder = await session.get(Reminder, reminder_id)
    assert reminder is not None
    assert reminder.status == ReminderStatus.SENT.value
    assert reminder.attempts == 1
    assert await _deliveries(reminder_id) == 1
    assert len(notifier.messages) == 1
    assert notifier.messages[0].dedupe_key == f"reminder:{reminder_id}"

    # Nothing left to claim, and the delivery record stands.
    assert await worker.run_once("worker-1") is False
    assert await _deliveries(reminder_id) == 1


async def test_a_retry_or_restart_does_not_deliver_twice(notifier: RecordingNotifier) -> None:
    user_id, task_id = await _seed_task()
    reminder_id = await _queue_ready_reminder(task_id, user_id)
    assert await worker.run_once("worker-1") is True

    # A second, duplicate job (as a restart or a retried job would leave) is claimed but is a no-op.
    async with session_scope() as session:
        reminder = await session.get(Reminder, reminder_id)
        assert reminder is not None
        await queue.enqueue(
            session,
            REMINDER_DELIVER_TASK,
            {"reminder_id": str(reminder_id), "remind_at": reminder.remind_at.isoformat()},
            run_at=datetime.now(UTC) - timedelta(minutes=1),
            idempotency_key=f"{REMINDER_DELIVER_TASK}:{reminder_id}:retry",
        )
    assert await worker.run_once("worker-2") is True

    assert await _deliveries(reminder_id) == 1
    assert len(notifier.messages) == 1


async def test_delivering_a_sent_reminder_again_is_skipped() -> None:
    user_id, task_id = await _seed_task()
    reminder_id = await _queue_ready_reminder(task_id, user_id)
    async with session_scope() as session:
        first = await deliver_reminder(session, reminder_id)
    assert first.delivered is True

    async with session_scope() as session:
        again = await deliver_reminder(session, reminder_id)
    assert again.delivered is False
    assert again.reason == "reminder is sent"
    assert await _deliveries(reminder_id) == 1


# --- a terminal or deleted entity is skipped ----------------------------------


@pytest.mark.parametrize("status", ["completed", "archived"])
async def test_a_completed_or_archived_task_is_skipped(
    status: str, notifier: RecordingNotifier
) -> None:
    user_id, task_id = await _seed_task()
    reminder_id = await _queue_ready_reminder(task_id, user_id)
    await _set_status(task_id, status)

    assert await worker.run_once("worker-1") is True

    async with session_scope() as session:
        reminder = await session.get(Reminder, reminder_id)
    assert reminder is not None
    assert reminder.status == ReminderStatus.CANCELLED.value
    assert await _deliveries(reminder_id) == 0
    assert notifier.messages == []


async def test_a_soft_deleted_task_is_skipped(notifier: RecordingNotifier) -> None:
    user_id, task_id = await _seed_task()
    reminder_id = await _queue_ready_reminder(task_id, user_id)
    await _set_status(task_id, "inbox", deleted=True)

    assert await worker.run_once("worker-1") is True
    assert await _deliveries(reminder_id) == 0
    assert notifier.messages == []


async def test_sync_cancels_a_reminder_when_the_task_becomes_terminal() -> None:
    user_id, task_id = await _seed_task()
    assert (await _sync(user_id, task_id)) is not None
    await _set_status(task_id, "completed")

    assert await _sync(user_id, task_id) is None
    reminder = await _get_reminder(task_id)
    assert reminder is not None
    assert reminder.status == ReminderStatus.CANCELLED.value


async def test_cancelling_a_reminder_skips_delivery(notifier: RecordingNotifier) -> None:
    user_id, task_id = await _seed_task()
    reminder_id = await _queue_ready_reminder(task_id, user_id)
    async with session_scope() as session:
        await ReminderService(session, user_id).cancel_for_task(task_id)

    assert await worker.run_once("worker-1") is True
    assert await _deliveries(reminder_id) == 0
    assert notifier.messages == []


# --- reschedule on a due-date edit --------------------------------------------


async def test_editing_a_due_date_reschedules_the_reminder() -> None:
    user_id, task_id = await _seed_task()
    first = await _sync(user_id, task_id)
    assert first is not None and first.remind_at == _DUE_REMIND

    new_due = datetime(2026, 6, 20, 15, 0, tzinfo=UTC)
    async with session_scope() as session:
        task = await session.get(Task, task_id)
        assert task is not None
        task.due_at = new_due
    second = await _sync(user_id, task_id)
    assert second is not None
    assert second.id == first.id  # one reminder per entity: edited in place
    assert second.remind_at == datetime(2026, 6, 20, 7, 0, tzinfo=UTC)

    async with session_scope() as session:
        rows = list(await session.scalars(select(Reminder).where(Reminder.entity_id == task_id)))
    assert len(rows) == 1

    # The superseded job for the old instant is a no-op; the new one delivers.
    async with session_scope() as session:
        stale = await deliver_reminder(session, second.id, expected_remind_at=_DUE_REMIND)
    assert stale.delivered is False
    assert stale.reason == "reminder was rescheduled"


async def test_the_api_reschedules_the_reminder_on_a_due_date_edit(client: AsyncClient) -> None:
    await create_user_via_setup(client)
    headers = csrf_headers(client)
    created = await client.post(
        "/api/tasks",
        json={"title": "Report", "due_at": _DUE.isoformat(), "time_zone": "Europe/Amsterdam"},
        headers=headers,
    )
    assert created.status_code == 201, created.text
    task_id = uuid.UUID(created.json()["id"])

    async with session_scope() as session:
        task = await session.get(Task, task_id)
        assert task is not None
        policy = ReminderPolicy(
            user_id=task.user_id, name="Default", days_before=0, at_time=time(9, 0)
        )
        session.add(policy)
        await session.flush()
        task.reminder_policy_id = policy.id
        user_id = task.user_id
    await _sync(user_id, task_id)
    assert (await _get_reminder(task_id)) is not None

    new_due = datetime(2026, 6, 21, 15, 0, tzinfo=UTC)
    patched = await client.patch(
        f"/api/tasks/{task_id}", json={"due_at": new_due.isoformat()}, headers=headers
    )
    assert patched.status_code == 200, patched.text

    reminder = await _get_reminder(task_id)
    assert reminder is not None
    assert reminder.remind_at == datetime(2026, 6, 21, 7, 0, tzinfo=UTC)


# --- the durable, idempotent scheduler sweep ----------------------------------


async def test_the_scan_sweep_is_durable_and_idempotent(notifier: RecordingNotifier) -> None:
    await _seed_task()

    async with session_scope() as session:
        await ensure_reminder_scan_job(session)
    async with session_scope() as session:
        await ensure_reminder_scan_job(session)  # idempotent: no second live scan
        live = list(
            await session.scalars(
                select(Job).where(
                    Job.task_name == REMINDERS_SCAN_TASK,
                    Job.status.in_(["pending", "running"]),
                )
            )
        )
    assert len(live) == 1

    # The worker runs the sweep, which materialises the reminder, queues the delivery and re-arms.
    assert await worker.run_once("worker-1") is True
    async with session_scope() as session:
        reminders = list(await session.scalars(select(Reminder)))
        delivery_jobs = list(
            await session.scalars(select(Job).where(Job.task_name == REMINDER_DELIVER_TASK))
        )
        scans = list(await session.scalars(select(Job).where(Job.task_name == REMINDERS_SCAN_TASK)))
    assert len(reminders) == 1
    assert len(delivery_jobs) == 1
    assert delivery_jobs[0].run_at == _DUE_REMIND
    assert any(job.status == "pending" for job in scans)  # the chain re-scheduled itself

    # A second sweep queues no duplicate delivery job.
    async with session_scope() as session:
        second = await scan_reminders(session)
    assert second.dispatched == 0
    async with session_scope() as session:
        delivery_jobs = list(
            await session.scalars(select(Job).where(Job.task_name == REMINDER_DELIVER_TASK))
        )
    assert len(delivery_jobs) == 1


async def test_the_scan_cancels_a_reminder_for_a_completed_task() -> None:
    user_id, task_id = await _seed_task()
    assert (await _sync(user_id, task_id)) is not None
    await _set_status(task_id, "completed")

    async with session_scope() as session:
        summary = await scan_reminders(session)
    assert summary.cancelled == 1
    reminder = await _get_reminder(task_id)
    assert reminder is not None
    assert reminder.status == ReminderStatus.CANCELLED.value


async def test_a_stale_running_scan_is_reaped_and_restarted() -> None:
    async with session_scope() as session:
        job = await queue.enqueue(session, REMINDERS_SCAN_TASK)
        job.status = "running"
        job.locked_by = "dead-worker"
        job.locked_at = datetime.now(UTC) - timedelta(hours=2)
        await session.flush()

    async with session_scope() as session:
        await ensure_reminder_scan_job(session)

    async with session_scope() as session:
        jobs = list(await session.scalars(select(Job).where(Job.task_name == REMINDERS_SCAN_TASK)))
    assert sorted(job.status for job in jobs) == ["failed", "pending"]


# --- strict user scoping ------------------------------------------------------


async def test_syncing_another_users_task_is_a_no_op() -> None:
    _, task_id = await _seed_task()
    other_user_id, _ = await _seed_task()
    async with session_scope() as session:
        assert await ReminderService(session, other_user_id).sync_for_task(task_id) is None
    assert await _get_reminder(task_id) is None


def test_remind_at_for_matches_the_schedule_helper() -> None:
    # Guards the fixture constants against accidental drift with the pure rule.
    assert (
        remind_at_for(_DUE, ReminderRule(0, time(9, 0)), tz_name="Europe/Amsterdam") == _DUE_REMIND
    )
