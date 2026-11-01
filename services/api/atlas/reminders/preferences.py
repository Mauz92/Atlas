"""Reminder timing preferences (M8-05).

The M8-01 reminder model already stores a per-user timing preference (``ReminderPolicy``:
``days_before`` whole days before the due calendar day, at ``at_time`` local wall-clock) and lets a
task reference one (``tasks.reminder_policy_id``). M8-05 adds the two things a preferences surface
needs and keeps the scheduling itself in M8-01:

- a **per-user default** timing — the single policy flagged ``is_default`` — applied to the user's
  tasks that name no policy of their own; and
- a **per-entity override** — a task's own referenced policy.

The pure rules (what a valid timing is, how it is named and rendered) live in this module so the API
and the service stay thin (``AGENTS.md`` §6). Rescheduling reuses the M8-01 machinery verbatim:
:func:`atlas.reminders.service.sync_task` recomputes the durable reminder and
:func:`atlas.reminders.service.ensure_delivery_job` re-keys its job for the new instant — there is
no second scheduler (``no new scheduling logic``).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, time

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Reminder, ReminderPolicy, Task
from .service import ensure_delivery_job, resolve_policy, sync_task

#: The largest whole-day lead we accept. A day-granularity policy (ADR-0037) — ``days_before`` +
#: ``at_time`` — is the approved M8-01 timing model; bounding it keeps an accidental huge value out.
MAX_DAYS_BEFORE = 30

#: The name of the single per-user default policy row (M8-05).
DEFAULT_POLICY_NAME = "Default"


class InvalidReminderTimingError(ValueError):
    """A reminder timing that cannot be represented as an M8-01 policy."""


@dataclass(frozen=True, slots=True)
class ReminderTiming:
    """A reminder timing: ``days_before`` whole days before the due day, at ``at_time`` local.

    This is exactly the M8-01 ``ReminderPolicy`` shape; :meth:`ReminderRule` is built from it by the
    scheduler, so nothing here duplicates the date arithmetic.
    """

    days_before: int = 0
    at_time: time = time(9, 0)

    def __post_init__(self) -> None:
        if not isinstance(self.days_before, int) or isinstance(self.days_before, bool):
            raise InvalidReminderTimingError("days_before must be a whole number of days")
        if self.days_before < 0 or self.days_before > MAX_DAYS_BEFORE:
            raise InvalidReminderTimingError(f"days_before must be between 0 and {MAX_DAYS_BEFORE}")
        if not isinstance(self.at_time, time):
            raise InvalidReminderTimingError("at_time must be a wall-clock time")


def parse_at_time(value: str) -> time:
    """Parse a strict ``HH:MM`` wall-clock string, or raise :class:`InvalidReminderTimingError`."""
    text = (value or "").strip()
    parts = text.split(":")
    if len(parts) != 2 or len(parts[0]) != 2 or len(parts[1]) != 2:
        raise InvalidReminderTimingError("at_time must be a 24-hour HH:MM time")
    if not (parts[0].isdigit() and parts[1].isdigit()):
        raise InvalidReminderTimingError("at_time must be a 24-hour HH:MM time")
    hour, minute = int(parts[0]), int(parts[1])
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise InvalidReminderTimingError("at_time must be a valid 24-hour HH:MM time")
    return time(hour, minute)


def format_at_time(value: time) -> str:
    """Render a stored wall-clock time as ``HH:MM`` (seconds are not part of the UI contract)."""
    return f"{value.hour:02d}:{value.minute:02d}"


def timing_of(policy: ReminderPolicy) -> ReminderTiming:
    """The :class:`ReminderTiming` a stored policy represents."""
    return ReminderTiming(days_before=policy.days_before, at_time=policy.at_time)


def canonical_name(timing: ReminderTiming) -> str:
    """A deterministic, unique-per-user name for a timing, so equal overrides share one policy row.

    The default policy keeps its reserved :data:`DEFAULT_POLICY_NAME`; an override policy is named
    after its timing (e.g. ``"1d 09:00"``), which is what makes a repeated override an update rather
    than a duplicate (``AGENTS.md`` §9).
    """
    return f"{timing.days_before}d {format_at_time(timing.at_time)}"


@dataclass(frozen=True, slots=True)
class TaskReminderState:
    """A task's reminder timing: its override (if any), effective timing and the fire instant."""

    override: ReminderTiming | None
    effective: ReminderTiming | None
    remind_at: datetime | None


class ReminderPreferencesService:
    """Read/write the caller's reminder timing. Strictly user-scoped (``AGENTS.md`` §9/§11``)."""

    def __init__(self, session: AsyncSession, user_id: uuid.UUID) -> None:
        self.session = session
        self.user_id = user_id

    # --- per-user default -------------------------------------------------

    async def get_default_policy(self) -> ReminderPolicy | None:
        """The caller's default reminder policy, or ``None`` when they have not set one."""
        policy: ReminderPolicy | None = await self.session.scalar(
            select(ReminderPolicy).where(
                ReminderPolicy.user_id == self.user_id,
                ReminderPolicy.is_default.is_(True),
            )
        )
        return policy

    async def get_default_timing(self) -> ReminderTiming | None:
        policy = await self.get_default_policy()
        return timing_of(policy) if policy is not None else None

    async def set_default_timing(self, timing: ReminderTiming) -> ReminderTiming:
        """Set (or update) the caller's default timing and reschedule the tasks it governs.

        Idempotent: the single default row is upserted, so repeating a save changes nothing. Every
        caller task that carries no override is re-materialised through the M8-01 scheduler, so an
        earlier or later timing takes effect immediately.
        """
        policy = await self.get_default_policy()
        if policy is None:
            policy = ReminderPolicy(
                user_id=self.user_id,
                name=DEFAULT_POLICY_NAME,
                days_before=timing.days_before,
                at_time=timing.at_time,
                is_default=True,
            )
            self.session.add(policy)
        else:
            policy.name = DEFAULT_POLICY_NAME
            policy.days_before = timing.days_before
            policy.at_time = timing.at_time
            policy.is_default = True
        await self.session.flush()
        await self._reschedule_inherited()
        return timing

    async def clear_default_timing(self) -> None:
        """Remove the caller's default timing and reschedule the tasks it governed.

        Idempotent: clearing a default that is not set is a no-op. The tasks that inherited the
        default lose their reminder (they name no policy of their own).
        """
        policy = await self.get_default_policy()
        if policy is None:
            return
        await self.session.execute(delete(ReminderPolicy).where(ReminderPolicy.id == policy.id))
        await self.session.flush()
        await self._reschedule_inherited()

    async def _reschedule_inherited(self) -> None:
        """Re-materialise every caller task that inherits the default (has no override)."""
        tasks = await self.session.scalars(
            select(Task).where(
                Task.user_id == self.user_id,
                Task.reminder_policy_id.is_(None),
                Task.deleted_at.is_(None),
            )
        )
        for task in tasks:
            reminder = await sync_task(self.session, task)
            if reminder is not None:
                await ensure_delivery_job(self.session, reminder)

    # --- per-entity override ---------------------------------------------

    async def get_task_reminder(self, task_id: uuid.UUID) -> TaskReminderState | None:
        """The reminder timing of one of the caller's tasks, or ``None`` when it is not theirs."""
        task = await self.session.get(Task, task_id)
        if task is None or task.user_id != self.user_id:
            return None
        return await self._state_for(task)

    async def set_task_override(
        self, task_id: uuid.UUID, timing: ReminderTiming | None
    ) -> TaskReminderState | None:
        """Set (or clear, with ``timing=None``) a task's override and reschedule just that task.

        Returns the new state, or ``None`` when the task is unknown or belongs to another user (so a
        task id can never be probed across users). Idempotent: the same timing reuses the same
        policy row and re-materialises the same reminder.
        """
        task = await self.session.get(Task, task_id)
        if task is None or task.user_id != self.user_id:
            return None
        if timing is None:
            task.reminder_policy_id = None
        else:
            policy = await self._get_or_create_policy(timing)
            task.reminder_policy_id = policy.id
        await self.session.flush()
        reminder = await sync_task(self.session, task)
        if reminder is not None:
            await ensure_delivery_job(self.session, reminder)
        return await self._state_for(task)

    async def _get_or_create_policy(self, timing: ReminderTiming) -> ReminderPolicy:
        """The caller's override policy for ``timing``, created on first use (idempotent)."""
        name = canonical_name(timing)
        policy = await self.session.scalar(
            select(ReminderPolicy).where(
                ReminderPolicy.user_id == self.user_id,
                ReminderPolicy.name == name,
            )
        )
        if policy is None:
            policy = ReminderPolicy(
                user_id=self.user_id,
                name=name,
                days_before=timing.days_before,
                at_time=timing.at_time,
                is_default=False,
            )
            self.session.add(policy)
            await self.session.flush()
        else:
            policy.days_before = timing.days_before
            policy.at_time = timing.at_time
        return policy

    async def _state_for(self, task: Task) -> TaskReminderState:
        policy = await resolve_policy(self.session, task)
        effective = timing_of(policy) if policy is not None else None
        override: ReminderTiming | None = None
        if task.reminder_policy_id is not None:
            own = await self.session.get(ReminderPolicy, task.reminder_policy_id)
            if own is not None and own.user_id == task.user_id:
                override = timing_of(own)
        reminder = await self.session.scalar(
            select(Reminder).where(
                Reminder.entity_type == "task",
                Reminder.entity_id == task.id,
            )
        )
        remind_at = reminder.remind_at if reminder is not None else None
        return TaskReminderState(override=override, effective=effective, remind_at=remind_at)


__all__ = [
    "DEFAULT_POLICY_NAME",
    "MAX_DAYS_BEFORE",
    "InvalidReminderTimingError",
    "ReminderPreferencesService",
    "ReminderTiming",
    "TaskReminderState",
    "canonical_name",
    "format_at_time",
    "parse_at_time",
    "timing_of",
]
