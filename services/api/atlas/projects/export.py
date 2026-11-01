"""Project export document (M4-07).

This module is the **stable, open contract** for exporting a user's projects together with their
tasks and the notes linked to them (REQ-015 data portability). It is deliberately pure: it takes
already-loaded rows and produces a plain ``dict`` document, so the exact wire shape can be
unit-tested without a database. The database reads live in
:meth:`atlas.projects.service.ProjectsService.export`; the API serialises the result unchanged.

**Format.** JSON, one *document* per export:

.. code-block:: text

    {
      "format": "atlas.project-export",   # fixed identifier, never changes
      "version": 1,                        # document schema version (see ADR-0026)
      "generated_at": "2026-10-26T12:00:00Z",
      "truncated": false,                  # true when more projects exist than were returned
      "projects": [ <ProjectExport>, ... ]
    }

Every timestamp/instant is an **ISO-8601 UTC** string (``…Z``); every calendar day
(``start_date``/``target_date``) is an ISO-8601 date (``YYYY-MM-DD``); every identifier is a
lower-case UUID string. Only **live** rows are exported: a soft-deleted (tombstoned) project,
task or note is never included (``deleted_at`` is not part of the document). ``archived`` tasks
*are* included — they are real data — while the project's derived ``progress`` follows the
canonical formula and therefore excludes them (`PRODUCT_SPEC.md` §5.3, ADR-0023).

The shape is versioned and additive: a consumer must tolerate unknown fields and must not infer
that a missing optional field is an error. ``version`` is bumped only for a breaking change
(recorded in ADR-0026 and ``CHANGELOG.md``).
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any

from .progress import ZERO_PROGRESS, ProjectProgress

#: Fixed document identifier — a consumer keys on this to recognise an Atlas project export.
EXPORT_FORMAT = "atlas.project-export"

#: Document schema version. Bump only for a breaking change (ADR-0026).
EXPORT_VERSION = 1


def _iso_utc(value: datetime) -> str:
    """An instant as ISO-8601 UTC with a ``Z`` suffix (e.g. ``2026-10-26T12:00:00Z``)."""
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _instant(value: datetime | None) -> str | None:
    """``None`` stays ``None``; otherwise :func:`_iso_utc`."""
    return None if value is None else _iso_utc(value)


def _calendar_day(value: date | None) -> str | None:
    """A calendar day as ``YYYY-MM-DD`` (``None`` stays ``None``)."""
    return None if value is None else value.isoformat()


def _identifier(value: uuid.UUID | None) -> str | None:
    """A UUID as a lower-case string (``None`` stays ``None``)."""
    return None if value is None else str(value)


@dataclass(frozen=True, slots=True)
class ProjectExport:
    """A project and the rows exported beneath it — one entry of the document's ``projects``.

    ``project``/``tasks``/``notes`` are duck-typed row objects (the ORM models in production; any
    object with the documented attributes in a unit test), which keeps this module free of any
    database import. ``tasks`` are ordered by capture (``created_at``, ``id``) and ``notes`` by
    ``path``; both orders are stable and are produced by the query in the service.
    """

    project: Any
    tasks: Sequence[Any]
    notes: Sequence[Any]
    progress: ProjectProgress = ZERO_PROGRESS


def task_document(task: Any) -> dict[str, Any]:
    """One task's documented fields (``DATA_MODEL.md`` §2.3), stored values only."""
    return {
        "id": str(task.id),
        "title": task.title,
        "description": task.description,
        "status": task.status,
        "priority": task.priority,
        "project_id": _identifier(task.project_id),
        "parent_task_id": _identifier(task.parent_task_id),
        "start_at": _instant(task.start_at),
        "due_at": _instant(task.due_at),
        "time_zone": task.time_zone,
        "duration_minutes": task.duration_minutes,
        "completed_at": _instant(task.completed_at),
        "recurrence_rule": task.recurrence_rule,
        "recurrence_parent_id": _identifier(task.recurrence_parent_id),
        "external_provider": task.external_provider,
        "external_id": task.external_id,
        "revision": task.revision,
        "created_at": _iso_utc(task.created_at),
        "updated_at": _iso_utc(task.updated_at),
    }


def note_document(note: Any) -> dict[str, Any]:
    """A linked note's summary (the same shape as ``NoteSummaryOut``)."""
    return {
        "id": str(note.id),
        "path": note.path,
        "title": note.title,
        "revision": note.revision,
        "content_hash": note.content_hash,
        "size_bytes": note.size_bytes,
    }


def project_document(entry: ProjectExport) -> dict[str, Any]:
    """One project with its derived progress, its tasks and its linked notes."""
    project = entry.project
    progress = entry.progress
    return {
        "id": str(project.id),
        "name": project.name,
        "description": project.description,
        "status": project.status,
        "start_date": _calendar_day(project.start_date),
        "target_date": _calendar_day(project.target_date),
        "revision": project.revision,
        "created_at": _iso_utc(project.created_at),
        "updated_at": _iso_utc(project.updated_at),
        "progress": {
            "total": progress.total,
            "completed": progress.completed,
            "percent": progress.percent,
        },
        "tasks": [task_document(task) for task in entry.tasks],
        "notes": [note_document(note) for note in entry.notes],
    }


def build_document(
    projects: Iterable[ProjectExport],
    *,
    generated_at: datetime,
    truncated: bool,
    version: int = EXPORT_VERSION,
    unfiled_tasks: Sequence[Any] | None = None,
) -> dict[str, Any]:
    """Assemble the versioned export document from already-loaded project entries.

    ``generated_at`` is the instant the snapshot was taken (the caller stamps it once, so every
    export is reproducible in shape); ``truncated`` reports whether the project bound cut the
    result short (see :meth:`ProjectsService.export`).

    ``unfiled_tasks`` is an **additive extension** used only by the M9-03 full export: when it is
    given (even empty), the document gains a top-level ``unfiled_tasks`` key holding the caller's
    live tasks that belong to no project, so a *full* export omits nothing. It is ``None`` (and the
    key absent) for the M4-07 project exports, whose shape is therefore unchanged; adding a key is
    additive and does not bump ``version`` (ADR-0026).
    """
    document: dict[str, Any] = {
        "format": EXPORT_FORMAT,
        "version": version,
        "generated_at": _iso_utc(generated_at),
        "truncated": truncated,
        "projects": [project_document(entry) for entry in projects],
    }
    if unfiled_tasks is not None:
        document["unfiled_tasks"] = [task_document(task) for task in unfiled_tasks]
    return document


__all__ = [
    "EXPORT_FORMAT",
    "EXPORT_VERSION",
    "ProjectExport",
    "build_document",
    "note_document",
    "project_document",
    "task_document",
]
