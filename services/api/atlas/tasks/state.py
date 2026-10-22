"""Task status state machine (M3-03).

Task status is an explicit state machine and this module is its single source of truth. Clients
move a task between statuses with a ``PATCH``; only the transitions in :data:`TRANSITIONS` are
accepted. Moving a task to the status it already has is not a transition and is rejected, as is
any move a status does not list. Board columns and quick actions (M4) must use these same rules.
"""

from __future__ import annotations

from datetime import datetime

from ..models import TaskStatus

INBOX = TaskStatus.INBOX.value
NEXT = TaskStatus.NEXT.value
IN_PROGRESS = TaskStatus.IN_PROGRESS.value
COMPLETED = TaskStatus.COMPLETED.value
ARCHIVED = TaskStatus.ARCHIVED.value

#: Allowed transitions. The three active statuses move freely among themselves and into
#: ``completed``/``archived``; a completed task may be reopened or archived; an archived task
#: may be restored to an active status. A status is never its own successor.
TRANSITIONS: dict[str, frozenset[str]] = {
    INBOX: frozenset({NEXT, IN_PROGRESS, COMPLETED, ARCHIVED}),
    NEXT: frozenset({INBOX, IN_PROGRESS, COMPLETED, ARCHIVED}),
    IN_PROGRESS: frozenset({INBOX, NEXT, COMPLETED, ARCHIVED}),
    COMPLETED: frozenset({IN_PROGRESS, ARCHIVED}),
    ARCHIVED: frozenset({INBOX, NEXT}),
}


class InvalidTaskTransitionError(ValueError):
    """A status change the state machine does not allow."""

    def __init__(self, current: str, requested: str) -> None:
        super().__init__(f"cannot move a task from {current!r} to {requested!r}")
        self.current = current
        self.requested = requested

    @property
    def allowed(self) -> frozenset[str]:
        return allowed_transitions(self.current)


def allowed_transitions(current: str) -> frozenset[str]:
    """The statuses a task in ``current`` may move to (empty for an unknown status)."""
    return TRANSITIONS.get(current, frozenset())


def can_transition(current: str, requested: str) -> bool:
    return requested in allowed_transitions(current)


def validate_transition(current: str, requested: str) -> None:
    """Raise :class:`InvalidTaskTransitionError` unless the move is allowed."""
    if not can_transition(current, requested):
        raise InvalidTaskTransitionError(current, requested)


def transition_fields(
    current: str | None, requested: str, *, now: datetime
) -> dict[str, datetime | None]:
    """Extra column changes implied by a (valid) transition.

    ``current`` is the status being left, or ``None`` when a task is created. The invariant is
    that ``completed_at`` is set exactly when a task is in ``completed``: entering ``completed``
    records the time, and leaving it clears the record.
    """
    was_completed = current == COMPLETED
    will_be_completed = requested == COMPLETED
    if will_be_completed and not was_completed:
        return {"completed_at": now}
    if was_completed and not will_be_completed:
        return {"completed_at": None}
    return {}
