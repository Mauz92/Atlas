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
from datetime import datetime

from sqlalchemy import String, exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..changes import ChangeEntityType, ChangeOperation, ChangeRecorder
from ..jobs import queue
from ..models import ChangeLog, Job, Reminder, ReminderPolicy, Task, User
from ..models.reminder import ReminderEntityType, ReminderStatus
from .constants import REMINDER_DELIVER_TASK
from .schedule import DELIVERABLE_STATUSES, ReminderRule, is_deliverable, remind_at_for

_TASK = ReminderEntityType.TASK.value

#: Device-visible reminder states (SYNC_PROTOCOL.md 14.2). ``sent`` deliberately does not exist
#: here: the server's own delivery (``Reminder.status``) says nothing about any device (G4).
ARMED = "armed"
CANCELLED = "cancelled"


class _Keep:
    """Sentinel: leave a nullable feed field as it is."""


KEEP = _Keep()


async def lock_for_update(session: AsyncSession, reminder: Reminder) -> None:
    """Lock the owner's row, then the reminder's, and reload the reminder under the lock.

    Every writer of a reminder takes the locks in this order (user, then reminder), which is the
    order the change recorder already imposes, so two writers cannot deadlock; the second one
    waits, then sees the first one's committed values instead of overwriting them. ``FOR NO KEY
    UPDATE`` leaves foreign-key checks (a task or delivery insert) unblocked.
    """
    await session.execute(
        select(User.id).where(User.id == reminder.user_id).with_for_update(key_share=True)
    )
    await session.refresh(reminder, with_for_update={"key_share": True})


async def publish(
    session: AsyncSession,
    reminder: Reminder,
    *,
    state: str | None = None,
    remind_at: datetime | None = None,
    snoozed_until: datetime | _Keep | None = KEEP,
    acknowledged_at: datetime | _Keep | None = KEEP,
) -> bool:
    """Apply feed-visible changes to ``reminder`` and announce them; ``True`` when anything moved.

    The single place where ``state``, ``remind_at``, ``snoozed_until`` and ``acknowledged_at`` are
    written, so that a change is always accompanied by ``revision + 1`` and a ``change_log`` entry
    in the same transaction, and an unchanged value records nothing (the cursor does not move; a
    scan is idempotent, SYNC_PROTOCOL.md 14.2). A new ``remind_at`` clears a snooze that was set for
    the old schedule unless the caller says otherwise. The caller holds :func:`lock_for_update`.
    """
    changed = False
    if remind_at is not None and reminder.remind_at != remind_at:
        reminder.remind_at = remind_at
        changed = True
        if isinstance(snoozed_until, _Keep):
            snoozed_until = None
    if state is not None and reminder.state != state:
        reminder.state = state
        changed = True
    if not isinstance(snoozed_until, _Keep) and reminder.snoozed_until != snoozed_until:
        reminder.snoozed_until = snoozed_until
        changed = True
    if not isinstance(acknowledged_at, _Keep) and reminder.acknowledged_at != acknowledged_at:
        reminder.acknowledged_at = acknowledged_at
        changed = True
    if changed:
        reminder.revision += 1
        await session.flush()
        await _announce(session, reminder)
    return changed


async def _announce(session: AsyncSession, reminder: Reminder) -> None:
    await ChangeRecorder(session, reminder.user_id).record(
        ChangeEntityType.REMINDER, str(reminder.id), ChangeOperation.UPSERT
    )


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


async def _reminder_for(
    session: AsyncSession, task_id: uuid.UUID, *, lock: bool = False
) -> Reminder | None:
    reminder: Reminder | None = await session.scalar(
        select(Reminder).where(Reminder.entity_type == _TASK, Reminder.entity_id == task_id)
    )
    if reminder is not None and lock:
        await lock_for_update(session, reminder)
    return reminder


async def effective_zone(session: AsyncSession, task: Task) -> str | None:
    """The zone a task's reminder is computed in: its own, else the owner's home zone (Q6), else
    ``None`` (UTC, the behaviour before M8-04a)."""
    if task.time_zone is not None:
        return task.time_zone
    owner = await session.get(User, task.user_id)
    return owner.home_time_zone if owner is not None else None


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
    reminder = await _reminder_for(session, task.id, lock=True)
    policy = await resolve_policy(session, task)
    deliverable = (
        policy is not None
        and task.due_at is not None
        and is_deliverable(status=task.status, deleted=task.deleted_at is not None)
    )
    if not deliverable:
        if reminder is not None:
            if reminder.status in (ReminderStatus.SCHEDULED.value, ReminderStatus.FAILED.value):
                reminder.status = ReminderStatus.CANCELLED.value
            await publish(session, reminder, state=CANCELLED)
        return None

    assert policy is not None and task.due_at is not None  # narrowed by ``deliverable`` above
    rule = ReminderRule(days_before=policy.days_before, at_time=policy.at_time)
    remind_at = remind_at_for(task.due_at, rule, tz_name=await effective_zone(session, task))
    if reminder is None:
        reminder = Reminder(
            user_id=task.user_id,
            policy_id=policy.id,
            entity_type=_TASK,
            entity_id=task.id,
            remind_at=remind_at,
            status=ReminderStatus.SCHEDULED.value,
            state=ARMED,
            revision=1,
        )
        session.add(reminder)
        await session.flush()
        await _announce(session, reminder)
        return reminder
    if reminder.status == ReminderStatus.SENT.value:
        # The server already delivered: ``remind_at`` stays frozen (a later due-date edit does not
        # re-notify), but a task that is open again is armed again for the devices.
        await publish(session, reminder, state=ARMED)
        return reminder
    reminder.policy_id = policy.id
    reminder.status = ReminderStatus.SCHEDULED.value
    await publish(session, reminder, state=ARMED, remind_at=remind_at)
    return reminder


async def cancel_for_task(session: AsyncSession, task_id: uuid.UUID) -> None:
    """Cancel a task's reminder; devices learn it through the feed (no-op if already cancelled)."""
    reminder = await _reminder_for(session, task_id, lock=True)
    if reminder is None:
        return
    if reminder.status in (ReminderStatus.SCHEDULED.value, ReminderStatus.FAILED.value):
        reminder.status = ReminderStatus.CANCELLED.value
    await publish(session, reminder, state=CANCELLED)


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
            select(Reminder).where(
                or_(
                    Reminder.status == ReminderStatus.SCHEDULED.value,
                    Reminder.state == ARMED,
                )
            )
        )
    )
    for reminder in reminders:
        entity = await _task_for(session, reminder)
        if entity is None or not is_deliverable(
            status=entity.status, deleted=entity.deleted_at is not None
        ):
            await lock_for_update(session, reminder)
            if reminder.status in (ReminderStatus.SCHEDULED.value, ReminderStatus.FAILED.value):
                reminder.status = ReminderStatus.CANCELLED.value
            if await publish(session, reminder, state=CANCELLED):
                cancelled += 1
            continue
        if reminder.status == ReminderStatus.SCHEDULED.value and await ensure_delivery_job(
            session, reminder
        ):
            dispatched += 1
    await emit_missing_changes(session)
    await session.flush()
    return ReminderScanSummary(
        considered=len(tasks), scheduled=scheduled, cancelled=cancelled, dispatched=dispatched
    )


async def emit_missing_changes(session: AsyncSession) -> int:
    """Announce every reminder that has no ``change_log`` entry yet (idempotent; returns how many).

    The migration backfills existing rows once; this is the safety net for a database restored
    from an older backup or a reminder written by a path that predates the feed. Re-running it
    finds nothing and does not move any cursor.
    """
    missing = list(
        await session.scalars(
            select(Reminder)
            .where(
                ~exists().where(
                    ChangeLog.user_id == Reminder.user_id,
                    ChangeLog.entity_type == ChangeEntityType.REMINDER.value,
                    ChangeLog.entity_id == Reminder.id.cast(String()),
                )
            )
            .order_by(Reminder.user_id, Reminder.remind_at, Reminder.id)
        )
    )
    for reminder in missing:
        await _announce(session, reminder)
    return len(missing)


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
    "ARMED",
    "CANCELLED",
    "KEEP",
    "ReminderScanSummary",
    "ReminderService",
    "cancel_for_task",
    "delivery_job_key",
    "effective_zone",
    "emit_missing_changes",
    "ensure_delivery_job",
    "lock_for_update",
    "publish",
    "resolve_policy",
    "scan_reminders",
    "sync_task",
]
