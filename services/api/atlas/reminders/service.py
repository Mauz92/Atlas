"""Reminder scheduling service (M8-01).

The scheduler turns an entity's due date and reminder policy into durable reminder state:

- :func:`sync_task` materialises (or updates, or cancels) a task's single
  :class:`~atlas.models.Reminder` row from its ``due_at``, ``reminder_policy_id``, status and
  deletion state. It runs on create/update/delete so an edited due date reschedules immediately and
  a cancelled/completed/deleted task cancels its reminder.
- :func:`ensure_delivery_job` puts one durable ``reminder.deliver`` job (M1-08) on the queue at the
  reminder's exact ``remind_at`` instant, keyed so re-scheduling never duplicates it.
- :func:`scan_reminders` is the recurring, restart-safe sweep: it re-materialises reminders for
  every eligible task (catching edits or tasks created while the worker was down) and re-queues any
  missed delivery, so the schedule survives a worker restart (``AGENTS.md`` §4).

Both the materialisation and the job key derive from the *pure* rules in
:mod:`atlas.reminders.schedule`, and the instant is computed in the entity's IANA zone (ADR-0014).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..jobs import queue
from ..models import Job, Reminder, ReminderPolicy, Task
from ..models.reminder import ReminderEntityType, ReminderStatus
from .constants import REMINDER_DELIVER_TASK
from .schedule import DELIVERABLE_STATUSES, ReminderRule, is_deliverable, remind_at_for

_TASK = ReminderEntityType.TASK.value


def delivery_job_key(reminder: Reminder) -> str:
    """A stable idempotency key for a reminder's delivery job at its current instant.

    Includes ``remind_at`` so a reschedule produces a new key (one durable job per scheduled
    instant) while re-materialising an unchanged reminder reuses the existing job.
    """
    return f"{REMINDER_DELIVER_TASK}:{reminder.id}:{int(reminder.remind_at.timestamp())}"


async def ensure_delivery_job(session: AsyncSession, reminder: Reminder) -> bool:
    """Queue the durable delivery job for ``reminder`` unless it already exists. Returns ``True``
    when a new job was queued.

    The job's ``run_at`` is the reminder's UTC instant, so the worker fires it at exactly the right
    time; because the job is durable, it is not lost if the worker restarts first.
    """
    key = delivery_job_key(reminder)
    existing = await session.scalar(select(Job.id).where(Job.idempotency_key == key))
    if existing is not None:
        return False
    await queue.enqueue(
        session,
        REMINDER_DELIVER_TASK,
        {"reminder_id": str(reminder.id), "remind_at": reminder.remind_at.isoformat()},
        run_at=reminder.remind_at,
        priority=10,
        idempotency_key=key,
    )
    return True


async def resolve_policy(session: AsyncSession, task: Task) -> ReminderPolicy | None:
    """The policy that governs ``task``: its own override, else the user's default (M8-05).

    A task that names a policy uses exactly that one; a task that names none falls back to the
    single ``is_default`` policy the task's owner has configured, if any. A reference that does not
    exist or belongs to another user is treated as "no policy" (defensive — a foreign policy must
    never govern a task, ``AGENTS.md`` §9/§11).
    """
    if task.reminder_policy_id is not None:
        policy = await session.get(ReminderPolicy, task.reminder_policy_id)
        if policy is not None and policy.user_id == task.user_id:
            return policy
        return None
    default: ReminderPolicy | None = await session.scalar(
        select(ReminderPolicy).where(
            ReminderPolicy.user_id == task.user_id,
            ReminderPolicy.is_default.is_(True),
        )
    )
    return default


async def _reminder_for(session: AsyncSession, task_id: uuid.UUID) -> Reminder | None:
    reminder: Reminder | None = await session.scalar(
        select(Reminder).where(Reminder.entity_type == _TASK, Reminder.entity_id == task_id)
    )
    return reminder


async def _task_for(session: AsyncSession, reminder: Reminder) -> Task | None:
    if reminder.entity_type != _TASK:
        return None
    return await session.get(Task, reminder.entity_id)


async def sync_task(session: AsyncSession, task: Task) -> Reminder | None:
    """Materialise the durable reminder for ``task``, or cancel it.

    Returns the reminder, or ``None`` when the task has no pending reminder. A task that is
    completed, archived or soft-deleted, has no due date, or has no reminder policy has no pending
    reminder: any existing scheduled/failed reminder is cancelled. A reminder that has already fired
    (``sent``) is left alone — editing a due date after delivery does not re-notify.
    """
    reminder = await _reminder_for(session, task.id)
    policy = await resolve_policy(session, task)
    deliverable = (
        policy is not None
        and task.due_at is not None
        and is_deliverable(status=task.status, deleted=task.deleted_at is not None)
    )
    if not deliverable:
        if reminder is not None and reminder.status in (
            ReminderStatus.SCHEDULED.value,
            ReminderStatus.FAILED.value,
        ):
            reminder.status = ReminderStatus.CANCELLED.value
            await session.flush()
        return None

    assert policy is not None and task.due_at is not None  # narrowed by ``deliverable`` above
    rule = ReminderRule(days_before=policy.days_before, at_time=policy.at_time)
    remind_at = remind_at_for(task.due_at, rule, tz_name=task.time_zone)
    if reminder is None:
        reminder = Reminder(
            user_id=task.user_id,
            policy_id=policy.id,
            entity_type=_TASK,
            entity_id=task.id,
            remind_at=remind_at,
            status=ReminderStatus.SCHEDULED.value,
        )
        session.add(reminder)
        await session.flush()
        return reminder
    if reminder.status == ReminderStatus.SENT.value:
        return reminder
    reminder.remind_at = remind_at
    reminder.policy_id = policy.id
    reminder.status = ReminderStatus.SCHEDULED.value
    await session.flush()
    return reminder


async def cancel_for_task(session: AsyncSession, task_id: uuid.UUID) -> None:
    """Cancel a task's reminder if one is still pending (a no-op otherwise)."""
    reminder = await _reminder_for(session, task_id)
    if reminder is not None and reminder.status in (
        ReminderStatus.SCHEDULED.value,
        ReminderStatus.FAILED.value,
    ):
        reminder.status = ReminderStatus.CANCELLED.value
        await session.flush()


@dataclass(frozen=True, slots=True)
class ReminderScanSummary:
    """What one scheduler sweep did, for logging and tests."""

    considered: int = 0
    scheduled: int = 0
    cancelled: int = 0
    dispatched: int = 0


async def scan_reminders(session: AsyncSession) -> ReminderScanSummary:
    """Re-materialise reminders for eligible tasks, cancel dead ones and re-queue missed deliveries.

    Safe to run at any time and idempotent: re-running changes nothing and queues no duplicate job.
    """
    tasks = list(
        await session.scalars(
            select(Task).where(
                Task.deleted_at.is_(None),
                Task.due_at.is_not(None),
                # Eligible when the task names its own policy (M8-01) *or* its owner has a default
                # (M8-05) that it would inherit — resolved per task by ``sync_task``.
                or_(
                    Task.reminder_policy_id.is_not(None),
                    Task.user_id.in_(
                        select(ReminderPolicy.user_id).where(ReminderPolicy.is_default.is_(True))
                    ),
                ),
                Task.status.in_(DELIVERABLE_STATUSES),
            )
        )
    )
    scheduled = 0
    for task in tasks:
        if await sync_task(session, task) is not None:
            scheduled += 1

    cancelled = 0
    dispatched = 0
    reminders = list(
        await session.scalars(
            select(Reminder).where(Reminder.status == ReminderStatus.SCHEDULED.value)
        )
    )
    for reminder in reminders:
        entity = await _task_for(session, reminder)
        if entity is None or not is_deliverable(
            status=entity.status, deleted=entity.deleted_at is not None
        ):
            reminder.status = ReminderStatus.CANCELLED.value
            cancelled += 1
            continue
        if await ensure_delivery_job(session, reminder):
            dispatched += 1
    await session.flush()
    return ReminderScanSummary(
        considered=len(tasks), scheduled=scheduled, cancelled=cancelled, dispatched=dispatched
    )


class ReminderService:
    """User-scoped facade used by the API when a task is created, edited or deleted."""

    def __init__(self, session: AsyncSession, user_id: uuid.UUID) -> None:
        self.session = session
        self.user_id = user_id

    async def sync_for_task(self, task_id: uuid.UUID) -> Reminder | None:
        """Recompute the reminder for one of the caller's tasks and queue its delivery job.

        Loading through the service enforces ownership: another user's task id is a silent no-op,
        so reminder ids cannot be probed across users.
        """
        task = await self.session.get(Task, task_id)
        if task is None or task.user_id != self.user_id:
            return None
        reminder = await sync_task(self.session, task)
        if reminder is not None:
            await ensure_delivery_job(self.session, reminder)
        return reminder

    async def cancel_for_task(self, task_id: uuid.UUID) -> None:
        task = await self.session.get(Task, task_id)
        if task is None or task.user_id != self.user_id:
            return
        await cancel_for_task(self.session, task_id)


__all__ = [
    "ReminderScanSummary",
    "ReminderService",
    "cancel_for_task",
    "delivery_job_key",
    "ensure_delivery_job",
    "resolve_policy",
    "scan_reminders",
    "sync_task",
]
