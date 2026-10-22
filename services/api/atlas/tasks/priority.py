"""Task priority (M3-04).

Priority is stored as one of the values in :class:`atlas.models.TaskPriority`. This module
provides the canonical low-to-high ordering used for sorting and filtering.
"""

from __future__ import annotations

from ..models import TaskPriority

#: Low to high urgency; the index is the sort rank.
PRIORITY_ORDER: tuple[str, ...] = (
    TaskPriority.NONE.value,
    TaskPriority.LOW.value,
    TaskPriority.MEDIUM.value,
    TaskPriority.HIGH.value,
    TaskPriority.URGENT.value,
)


class UnknownPriorityError(ValueError):
    def __init__(self, value: str) -> None:
        super().__init__(f"unknown priority: {value!r}")
        self.value = value


def priority_rank(value: str) -> int:
    """Sort rank for a priority value (higher means more urgent)."""
    try:
        return PRIORITY_ORDER.index(value)
    except ValueError as exc:
        raise UnknownPriorityError(value) from exc
