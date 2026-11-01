"""Pure reminder scheduling rules (M8-01).

A reminder fires at a wall-clock time on the entity's IANA zone (``PRODUCT_SPEC.md`` §5.6): "the day
``days_before`` before the due date, at ``at_time`` local time". The instant is computed from the
entity's UTC due instant by delegating to :mod:`atlas.tasks.timezones` — there is **no new date
arithmetic here** (ADR-0014).

Daylight saving is handled explicitly: a wall-clock time inside the spring-forward gap does not
exist. Rather than silently dropping the reminder (``AGENTS.md`` §9 — a reminder must never vanish),
the reminder rolls forward to the first instant after the gap; the fall-back overlap resolves to the
first occurrence, matching ``to_utc``'s default ``fold=0``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, time, timedelta

from ..models import TaskStatus
from ..tasks.timezones import NonexistentWallTimeError, get_zone, to_local, to_utc

#: Task statuses for which a reminder may still fire. A completed, archived or soft-deleted entity
#: is never reminded (``PRODUCT_SPEC.md`` §5.6).
DELIVERABLE_STATUSES: frozenset[str] = frozenset(
    {TaskStatus.INBOX.value, TaskStatus.NEXT.value, TaskStatus.IN_PROGRESS.value}
)

DEFAULT_AT_TIME = time(9, 0)


class InvalidReminderRuleError(ValueError):
    """A reminder policy that cannot be scheduled."""


@dataclass(frozen=True, slots=True)
class ReminderRule:
    """How far before the due date, and at what local wall-clock time, to remind."""

    days_before: int = 0
    at_time: time = DEFAULT_AT_TIME

    def __post_init__(self) -> None:
        if self.days_before < 0:
            raise InvalidReminderRuleError("days_before must not be negative")
        if not isinstance(self.at_time, time):
            raise InvalidReminderRuleError("at_time must be a wall-clock time")


def is_deliverable(*, status: str, deleted: bool) -> bool:
    """Whether an entity in this state may still produce a reminder."""
    return not deleted and status in DELIVERABLE_STATUSES


def remind_at_for(due_at: datetime, rule: ReminderRule, *, tz_name: str | None = None) -> datetime:
    """The UTC instant a reminder should fire for an entity due at ``due_at``.

    ``due_at`` is a UTC instant; it is converted to the entity's zone, moved back ``days_before``
    calendar days and pinned to ``rule.at_time`` local, then converted back to UTC. The result is
    time-zone correct across daylight-saving changes because the conversion goes through
    :func:`atlas.tasks.timezones.to_utc`.
    """
    local_due = to_local(due_at, tz_name)
    target_day = local_due.date() - timedelta(days=rule.days_before)
    wall = datetime.combine(target_day, rule.at_time)
    try:
        return to_utc(wall, tz_name)
    except NonexistentWallTimeError:
        # The local time fell in the spring-forward gap. Fire at the first instant after the gap
        # instead of dropping the reminder; ``tzinfo`` gives the pre-transition offset, so the
        # resulting UTC instant is just past the skipped hour.
        zone = get_zone(tz_name) if tz_name is not None else UTC
        return wall.replace(tzinfo=zone).astimezone(UTC)


__all__ = [
    "DEFAULT_AT_TIME",
    "DELIVERABLE_STATUSES",
    "InvalidReminderRuleError",
    "ReminderRule",
    "is_deliverable",
    "remind_at_for",
]
