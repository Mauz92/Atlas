"""Task service: PostgreSQL-backed CRUD and status transitions (Milestone 3)."""

from .service import (
    TaskNotFoundError,
    TaskRevisionConflictError,
    TasksService,
    TaskValidationError,
)
from .state import (
    InvalidTaskTransitionError,
    allowed_transitions,
    can_transition,
    validate_transition,
)

__all__ = [
    "InvalidTaskTransitionError",
    "TaskNotFoundError",
    "TaskRevisionConflictError",
    "TaskValidationError",
    "TasksService",
    "allowed_transitions",
    "can_transition",
    "validate_transition",
]
