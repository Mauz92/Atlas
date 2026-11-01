"""Project service: PostgreSQL CRUD with soft delete and revision-aware updates (Milestone 4)."""

from .export import (
    EXPORT_FORMAT,
    EXPORT_VERSION,
    ProjectExport,
    build_document,
    note_document,
    project_document,
    task_document,
)
from .links import NoteProjectLinks
from .progress import (
    ZERO_PROGRESS,
    ProgressTask,
    ProjectProgress,
    progress_from_status_counts,
    project_progress,
)
from .service import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    ProjectNotFoundError,
    ProjectRevisionConflictError,
    ProjectsService,
    ProjectValidationError,
)

__all__ = [
    "DEFAULT_LIMIT",
    "EXPORT_FORMAT",
    "EXPORT_VERSION",
    "MAX_LIMIT",
    "ZERO_PROGRESS",
    "NoteProjectLinks",
    "ProgressTask",
    "ProjectExport",
    "ProjectNotFoundError",
    "ProjectProgress",
    "ProjectRevisionConflictError",
    "ProjectValidationError",
    "ProjectsService",
    "build_document",
    "note_document",
    "progress_from_status_counts",
    "project_document",
    "project_progress",
    "task_document",
]
