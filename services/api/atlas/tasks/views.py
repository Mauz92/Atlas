"""Inbox / Today / Upcoming view rules (M3-07).

The primary task views are server-authoritative: the client asks for a view and the API returns
the matching tasks (ARCHITECTURE.md §8, PRODUCT_SPEC §5.7). This module holds the *pure* rules
behind those views; the database query and the serialisation live in
:mod:`atlas.tasks.service` and :mod:`atlas.api.tasks` respectively, so the rules can be tested
without a database and have a single canonical home (the pattern used by ``state.py``,
``priority.py`` and ``subtasks.py``).

A task's due date is judged in the task's own IANA zone when one is set, falling back to the
caller's zone (the ``tz`` the client sends, e.g. its browser's zone) and finally to UTC. "Overdue"
is a pure instant comparison; "today" compares calendar dates in that zone, so the classification
stays correct across daylight-saving changes and time-zone boundaries (ADR-0014). No new date
arithmetic is introduced here — everything delegates to :mod:`atlas.tasks.timezones`.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from ..models import TaskStatus
from .timezones import DueState, due_state


class UnknownViewError(ValueError):
    """A view name the API does not define."""

    def __init__(self, view: str) -> None:
        super().__init__(f"unknown task view: {view!r}")
        self.view = view


class TaskView(StrEnum):
    """The primary task views. ``Task``, ``Projects`` and ``Search`` are separate concerns."""

    INBOX = "inbox"
    TODAY = "today"
    UPCOMING = "upcoming"


#: Statuses that are never part of an active view (Today / Upcoming). An ``inbox`` task *is* part
#: of the Inbox view and may still appear in Today/Upcoming when it is due.
INACTIVE_STATUSES: frozenset[str] = frozenset(
    {TaskStatus.COMPLETED.value, TaskStatus.ARCHIVED.value}
)

#: Due states the Today view shows: work that is late or due on the caller's calendar day.
_TODAY_STATES: frozenset[DueState] = frozenset({DueState.OVERDUE, DueState.TODAY})


def effective_time_zone(
    task_time_zone: str | None, caller_time_zone: str | None = None
) -> str | None:
    """The zone a task's due date is judged in.

    The task's own zone wins when it has one (ADR-0014); otherwise the caller's zone is used, so
    "today" is the viewer's calendar day; ``None`` means UTC.
    """
    return task_time_zone or caller_time_zone


def due_state_for(
    due_at: datetime | None,
    *,
    now: datetime,
    task_time_zone: str | None = None,
    caller_time_zone: str | None = None,
) -> DueState:
    """Classify ``due_at`` for display, reusing the canonical :func:`due_state` helper."""
    return due_state(
        due_at,
        now=now,
        tz_name=effective_time_zone(task_time_zone, caller_time_zone),
    )


def matches_view(view: TaskView, *, status: str, state: DueState) -> bool:
    """Whether a task with the given ``status`` and ``state`` belongs in ``view``.

    - ``inbox``: the task is in the ``inbox`` status (quick capture, triage later);
    - ``today``: the task is due today or overdue and is not completed/archived;
    - ``upcoming``: the task is due on a later calendar day and is not completed/archived.
    """
    if view is TaskView.INBOX:
        return status == TaskStatus.INBOX.value
    if status in INACTIVE_STATUSES:
        return False
    if view is TaskView.TODAY:
        return state in _TODAY_STATES
    if view is TaskView.UPCOMING:
        return state is DueState.UPCOMING
    raise UnknownViewError(str(view))
