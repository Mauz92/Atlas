"""Derived project progress (M4-04).

Progress is **derived, not stored** (``DATA_MODEL.md`` §2.3): the ``projects`` table has no progress
column and the value is recomputed from the project's tasks on every read. This module is the single
source of truth for the rule; the service produces its inputs with one grouped query (so listing
many projects never becomes a query per project) and the API only serialises the result.

**Canonical formula.** For a project, over its tasks:

- ``total`` = the number of its tasks that are **live** (not soft-deleted) and **not** ``archived``;
- ``completed`` = the number of those tasks whose status is ``completed`` (a subset of ``total``);
- ``percent`` = ``round(completed * 100 / total)`` to the nearest whole percent, halves rounded
  **up**; when ``total`` is 0 — the project has no countable tasks — the progress is ``0/0`` and
  ``percent`` is **0**, because a project with no work is *not* complete.

Excluded tasks therefore never affect a project's progress: soft-deleted (tombstoned) tasks,
``archived`` tasks, and tasks filed under a different project or under none. Archiving a completed
task stops it counting, which is what "excluding archived" means.
"""

from __future__ import annotations

import uuid
from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import dataclass

from ..tasks.state import ARCHIVED, COMPLETED


@dataclass(frozen=True, slots=True)
class ProjectProgress:
    """Derived progress of one project: ``completed`` of ``total`` countable tasks."""

    total: int
    completed: int
    percent: int


#: The progress of a project with no countable tasks (also the default for an unknown project).
ZERO_PROGRESS = ProjectProgress(total=0, completed=0, percent=0)


@dataclass(frozen=True, slots=True)
class ProgressTask:
    """The task fields that decide a task's contribution to a project's progress."""

    status: str
    project_id: uuid.UUID | None = None
    deleted: bool = False


def _percent(completed: int, total: int) -> int:
    """Nearest whole percent, halves rounded up, in integer arithmetic; ``0`` when total is 0."""
    if total <= 0:
        return 0
    return (completed * 200 + total) // (2 * total)


def progress_from_status_counts(counts: Mapping[str, int]) -> ProjectProgress:
    """Progress from a project's **live** tasks grouped by status.

    ``counts`` maps a status to the number of the project's live tasks in it — exactly the shape a
    ``GROUP BY status`` count yields. ``archived`` is dropped here, so callers need not filter it.
    """
    total = sum(count for status, count in counts.items() if status != ARCHIVED)
    completed = counts.get(COMPLETED, 0)
    return ProjectProgress(total=total, completed=completed, percent=_percent(completed, total))


def project_progress(
    project_id: uuid.UUID | None, tasks: Iterable[ProgressTask]
) -> ProjectProgress:
    """The same rule applied in Python to task snapshots (the unit-tested reference).

    A task counts only when it belongs to ``project_id``, is live (``deleted`` is false) and is not
    ``archived``. The service computes the identical values in SQL using one grouped count; this
    function keeps the membership/liveness/archived rule testable without a database.
    """
    counts = Counter(
        task.status for task in tasks if task.project_id == project_id and not task.deleted
    )
    return progress_from_status_counts(counts)
