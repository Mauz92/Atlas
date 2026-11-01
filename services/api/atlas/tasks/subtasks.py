"""Parent/child (subtask) rules (M3-06).

A subtask is a task whose ``parent_task_id`` points at another task of the same user
(``docs/DATA_MODEL.md`` §2.3, the ``Task 1─* Task`` relation). This module holds the *pure*
rules; the database lookups that feed them live in :mod:`atlas.tasks.service`, so the rules can
be tested without a database and have a single canonical home (ADR-0016).

Rules enforced server-side:

- a task may not be its own parent, nor its own ancestor at any depth (no cycles);
- a parent must exist, belong to the same user and not be soft-deleted;
- a subtask shares its parent's ``project_id`` — the parent's project is inherited;
- completion *rolls up* as a derived count only: completing subtasks never completes the parent,
  because the status state machine (ADR-0013) remains the only way to complete a task.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from dataclasses import dataclass

from ..models import TaskStatus


class SubtaskError(ValueError):
    """A parent/child rule was violated."""


@dataclass(frozen=True)
class ParentRef:
    """The facts about a proposed parent that the rules need.

    ``ancestor_ids`` are the ids of the parent's ancestors (its parent, grandparent, …), closest
    first; the parent itself is not included.
    """

    id: uuid.UUID
    project_id: uuid.UUID | None
    ancestor_ids: tuple[uuid.UUID, ...] = ()


def ensure_parent_is_usable(*, found: bool, same_user: bool, deleted: bool) -> None:
    """Raise unless the proposed parent exists, belongs to the user and is not deleted.

    A single message is used for every failure so an attacker cannot tell whether an id belongs
    to another user's task or does not exist at all.
    """
    if not found or not same_user or deleted:
        raise SubtaskError("parent task does not exist")


def validate_parent(*, task_id: uuid.UUID | None, parent: ParentRef) -> None:
    """Reject self-parenting and any cycle (a task being its own ancestor at any depth).

    ``task_id`` is the task being (re)parented, or ``None`` when it is brand new — a new task
    cannot already be anyone's ancestor.
    """
    if task_id is None:
        return
    if parent.id == task_id:
        raise SubtaskError("a task cannot be its own parent")
    if task_id in parent.ancestor_ids:
        raise SubtaskError("a task cannot be its own ancestor")


def subtask_project_id(
    requested_project_id: uuid.UUID | None,
    parent_project_id: uuid.UUID | None,
    *,
    provided: bool,
) -> uuid.UUID | None:
    """The project a subtask must use.

    When the client did not send a ``project_id`` (``provided=False``) the subtask inherits the
    parent's project. When one is sent it must equal the parent's, otherwise :class:`SubtaskError`
    is raised: a subtask always shares its parent's project.
    """
    if not provided:
        return parent_project_id
    if requested_project_id != parent_project_id:
        raise SubtaskError("a subtask must share its parent's project")
    return requested_project_id


@dataclass(frozen=True)
class SubtaskRollup:
    """Derived completion counts for a task's direct, non-deleted subtasks."""

    total: int = 0
    done: int = 0

    @property
    def all_done(self) -> bool:
        """True when the task has at least one subtask and every one of them is completed."""
        return self.total > 0 and self.done == self.total


def rollup_from_statuses(statuses: Iterable[str]) -> SubtaskRollup:
    """Compute the rollup for a task from its direct subtasks' statuses."""
    values = list(statuses)
    done = sum(1 for status in values if status == TaskStatus.COMPLETED.value)
    return SubtaskRollup(total=len(values), done=done)
