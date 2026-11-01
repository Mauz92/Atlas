"""Project CRUD.

Projects are PostgreSQL-owned (``DATA_MODEL.md`` §2.3). Every mutation bumps the project's
``revision``; an update may carry the ``base_revision`` it was based on and is rejected if the
project has moved on. Deletion is a soft delete (tombstone) so a removed project can propagate to
clients, mirroring tasks.

The service is strictly user-scoped: a project belonging to another user is indistinguishable from
a missing one (``ProjectNotFoundError``), so callers cannot probe for its existence.

**Tombstone semantics for tasks (M4-02, ADR-0021).** Deleting a project never deletes a task. Its
*live* tasks are *unfiled*: their ``project_id`` is cleared and their ``revision`` incremented, so
the change feed (``GET /api/tasks/changes``) delivers the now-unfiled task to offline clients. This
is the same outcome the ``tasks.project_id`` foreign key's ``ON DELETE SET NULL`` produces on the
hard-delete paths, applied on the ordinary (soft) delete path. Tasks that are themselves
tombstoned are left exactly as they are: they are already invisible, so clearing them would only
add churn.

**Note↔project links (M4-05, ADR-0024).** A project may be linked to any number of the caller's
notes (``note_projects``, owned by :mod:`atlas.projects.links`). Deleting a project also removes
those link rows in the same transaction — the association is meaningless once the project is gone —
and never touches the notes themselves.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..changes import (
    ChangeEntityType,
    ChangeOperation,
    ChangeRecorder,
    entity_id_for,
    note_project_link_id,
)
from ..models import NoteIndex, NoteProject, Project, ProjectStatus, Task
from .export import ProjectExport
from .progress import ZERO_PROGRESS, ProjectProgress, progress_from_status_counts

#: Columns a client may set. Identity, owner and sync fields are managed by the service.
_WRITABLE = frozenset({"name", "description", "status", "start_date", "target_date"})

DEFAULT_LIMIT = 200
MAX_LIMIT = 500

_VALID_STATUSES = {status.value for status in ProjectStatus}


class ProjectNotFoundError(LookupError):
    pass


class ProjectValidationError(ValueError):
    pass


class ProjectRevisionConflictError(RuntimeError):
    """The project changed since the client last read it."""

    def __init__(self, current_revision: int) -> None:
        super().__init__("project has changed since it was read")
        self.current_revision = current_revision


def _as_date(value: Any, field: str) -> date | None:
    """Accept an ISO date (or ``None``) at the service boundary."""
    if value is None or (isinstance(value, date) and not isinstance(value, datetime)):
        return value
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, str):
        try:
            return date.fromisoformat(value)
        except ValueError as exc:
            raise ProjectValidationError(f"{field} must be an ISO date") from exc
    raise ProjectValidationError(f"{field} must be an ISO date")


def _validate_dates(fields: Mapping[str, Any]) -> None:
    """Reject a date range where the start is after the target."""
    start = _as_date(fields.get("start_date"), "start_date")
    target = _as_date(fields.get("target_date"), "target_date")
    if start is not None and target is not None and start > target:
        raise ProjectValidationError("start_date must not be after target_date")


def _validate_status(status: Any) -> str:
    if status not in _VALID_STATUSES:
        raise ProjectValidationError("unknown project status")
    return str(status)


class ProjectsService:
    def __init__(self, session: AsyncSession, user_id: uuid.UUID) -> None:
        self.session = session
        self.user_id = user_id

    async def get(self, project_id: uuid.UUID) -> Project:
        """The caller's live project, or ``ProjectNotFoundError`` (including another user's)."""
        project = await self.session.scalar(
            select(Project).where(
                Project.id == project_id,
                Project.user_id == self.user_id,
                Project.deleted_at.is_(None),
            )
        )
        if project is None:
            raise ProjectNotFoundError(str(project_id))
        return project

    async def list(self, *, limit: int = DEFAULT_LIMIT) -> list[Project]:
        """The caller's live projects in capture order (deterministic by ``created_at``, ``id``)."""
        projects = await self.session.scalars(
            select(Project)
            .where(Project.user_id == self.user_id, Project.deleted_at.is_(None))
            .order_by(Project.created_at, Project.id)
            .limit(limit)
        )
        return list(projects)

    async def progress(self, project_ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, ProjectProgress]:
        """Derived progress for the given projects in **one** grouped query (no N+1).

        Counts the caller's live tasks in those projects grouped by ``(project_id, status)`` and
        applies the canonical formula (:func:`atlas.projects.progress.progress_from_status_counts`),
        so listing ``N`` projects costs a single extra round-trip rather than one query per project.
        The status-level exclusion of ``archived`` lives in the formula; the query additionally
        ignores tombstoned tasks (``deleted_at IS NULL``) and any task filed elsewhere.

        A project with no countable tasks is either absent from the mapping or mapped to
        :data:`atlas.projects.progress.ZERO_PROGRESS`; callers should fall back to it, e.g.
        ``progress.get(project_id, ZERO_PROGRESS)``.
        """
        ids = list(project_ids)
        if not ids:
            return {}
        rows = (
            await self.session.execute(
                select(Task.project_id, Task.status, func.count())
                .where(
                    Task.user_id == self.user_id,
                    Task.deleted_at.is_(None),
                    Task.project_id.in_(ids),
                )
                .group_by(Task.project_id, Task.status)
            )
        ).all()
        counts_by_project: dict[uuid.UUID, dict[str, int]] = {}
        for project_id, status, count in rows:
            if project_id is None:  # unreachable: the query only matches the given ids
                continue
            counts_by_project.setdefault(project_id, {})[status] = count
        return {
            project_id: progress_from_status_counts(counts)
            for project_id, counts in counts_by_project.items()
        }

    # --- Export (M4-07) ----------------------------------------------------------

    async def begin_consistent_read(self) -> None:
        """Open a **REPEATABLE READ** transaction so an export is one consistent snapshot.

        The export reads several tables (projects, tasks, notes and the progress counts); under
        PostgreSQL's default READ COMMITTED each statement would see its own snapshot, so a
        concurrent write between two of them could tear the document. REPEATABLE READ gives the
        whole transaction a single snapshot, so every read in
        :meth:`export` observes the same point in time.

        Ending the request's current (read-only) transaction first is required: an isolation level
        can only be chosen for a *new* transaction. Nothing has been written by the time an export
        runs, so the rollback discards nothing; the caller must read any ORM attributes it still
        needs (e.g. the user id) *before* calling this.
        """
        await self.session.rollback()
        await self.session.connection(execution_options={"isolation_level": "REPEATABLE READ"})

    async def export(
        self, *, project_id: uuid.UUID | None = None, limit: int = DEFAULT_LIMIT
    ) -> tuple[Sequence[ProjectExport], bool]:
        """Load the data for a project export as one consistent snapshot (M4-07).

        With ``project_id`` a single, live, caller-owned project is exported (an unknown, another
        user's or tombstoned project raises :class:`ProjectNotFoundError`); otherwise the caller's
        live projects are exported in capture order, bounded to ``limit``. The returned flag is
        ``True`` when more projects exist than the bound returned (the document's ``truncated``),
        so a consumer knows the snapshot is partial. A single-project export is never truncated.

        Everything is read inside one REPEATABLE READ transaction (:meth:`begin_consistent_read`):
        the projects, then the tasks of exactly those projects, then their linked notes, then the
        derived progress — four queries total regardless of how many projects there are (no N+1).
        Only live rows are read; a task's nested ``project_id`` is therefore always in the snapshot.
        """
        await self.begin_consistent_read()
        if project_id is not None:
            selected = [await self.get(project_id)]
            truncated = False
        else:
            # Fetch one extra row to learn whether the bound cut the result short, without a
            # second count query; the extra row is dropped before serialisation.
            rows = await self.list(limit=limit + 1)
            truncated = len(rows) > limit
            selected = rows[:limit]
        ids = [project.id for project in selected]
        tasks = await self._export_tasks(ids)
        notes = await self._export_notes(ids)
        progress = await self.progress(ids)
        return (
            [
                ProjectExport(
                    project=project,
                    tasks=tasks.get(project.id, ()),
                    notes=notes.get(project.id, ()),
                    progress=progress.get(project.id, ZERO_PROGRESS),
                )
                for project in selected
            ],
            truncated,
        )

    async def _export_tasks(
        self, project_ids: Sequence[uuid.UUID]
    ) -> Mapping[uuid.UUID, Sequence[Task]]:
        """The live tasks of the given projects, grouped by project, in capture order.

        One query for every project (``project_id IN (…)``), so exporting many projects does not
        become a query per project. Soft-deleted tasks are excluded; ``archived`` tasks are kept —
        they are real data and the export is a faithful copy, while the derived ``progress`` is the
        figure that excludes them.
        """
        if not project_ids:
            return {}
        rows = await self.session.scalars(
            select(Task)
            .where(
                Task.user_id == self.user_id,
                Task.deleted_at.is_(None),
                Task.project_id.in_(project_ids),
            )
            .order_by(Task.created_at, Task.id)
        )
        grouped: dict[uuid.UUID, list[Task]] = {}
        for task in rows:
            if task.project_id is None:  # unreachable: the query restricts to the given ids
                continue
            grouped.setdefault(task.project_id, []).append(task)
        return grouped

    async def _export_notes(
        self, project_ids: Sequence[uuid.UUID]
    ) -> Mapping[uuid.UUID, Sequence[NoteIndex]]:
        """The live notes linked to the given projects, grouped by project, in path order (M4-05).

        One query joining ``note_projects`` to ``notes`` for every project; tombstoned/deleted
        notes are excluded (their links are removed on delete, and the join filters as defence in
        depth). The link references the note's stable id, so a renamed note is exported at its
        current path.
        """
        if not project_ids:
            return {}
        rows = (
            await self.session.execute(
                select(NoteProject.project_id, NoteIndex)
                .join(NoteIndex, NoteIndex.id == NoteProject.note_id)
                .where(
                    NoteProject.project_id.in_(project_ids),
                    NoteIndex.user_id == self.user_id,
                    NoteIndex.deleted_at.is_(None),
                )
                .order_by(NoteProject.project_id, NoteIndex.path)
            )
        ).all()
        grouped: dict[uuid.UUID, list[NoteIndex]] = {}
        for owner_id, note in rows:
            grouped.setdefault(owner_id, []).append(note)
        return grouped

    async def create(self, data: Mapping[str, Any]) -> Project:
        fields = {name: value for name, value in data.items() if name in _WRITABLE}
        if not str(fields.get("name", "")).strip():
            raise ProjectValidationError("name must not be empty")
        fields["name"] = str(fields["name"]).strip()
        if "status" in fields and fields["status"] is not None:
            fields["status"] = _validate_status(fields["status"])
        _validate_dates(fields)
        project = Project(user_id=self.user_id)
        for name, value in fields.items():
            setattr(project, name, value)
        self.session.add(project)
        await self.session.flush()
        await self._record_change(project.id, ChangeOperation.UPSERT)
        await self.session.refresh(project)
        return project

    async def update(
        self,
        project_id: uuid.UUID,
        changes: Mapping[str, Any],
        base_revision: int | None = None,
    ) -> Project:
        project = await self.get(project_id)
        if base_revision is not None and base_revision != project.revision:
            raise ProjectRevisionConflictError(project.revision)
        fields = {name: value for name, value in changes.items() if name in _WRITABLE}
        if "name" in fields:
            if not str(fields["name"]).strip():
                raise ProjectValidationError("name must not be empty")
            fields["name"] = str(fields["name"]).strip()
        if "status" in fields and fields["status"] is not None:
            fields["status"] = _validate_status(fields["status"])
        # Validate the merged range so clearing/setting one end cannot store an inverted range.
        _validate_dates(
            {
                "start_date": fields.get("start_date", project.start_date),
                "target_date": fields.get("target_date", project.target_date),
            }
        )
        for name, value in fields.items():
            setattr(project, name, value)
        project.revision += 1
        await self.session.flush()
        await self._record_change(project.id, ChangeOperation.UPSERT)
        await self.session.refresh(project)
        return project

    async def delete(self, project_id: uuid.UUID) -> None:
        """Soft delete (tombstone) the project; unfile its live tasks and drop its note links.

        The project row is retained so clients observe the removal. Its **live** tasks are never
        deleted: each one's ``project_id`` is cleared and its ``revision`` bumped (one statement, so
        the whole tombstone is atomic), which is the documented M4-02 behaviour (ADR-0021) and the
        application-level mirror of the foreign key's ``ON DELETE SET NULL``. Tasks that are already
        tombstoned are left untouched.

        The project's note↔project links are removed in the same transaction (M4-05, ADR-0024): a
        link is a pure association, so leaving it behind would dangle from a note whose project is
        gone. No note is deleted.
        """
        project = await self.get(project_id)
        unfiled = await self._unfile_tasks(project.id)
        unlinked = await self._remove_note_links(project.id)
        project.deleted_at = datetime.now(UTC)
        project.revision += 1
        await self.session.flush()
        # Announce the removal and everything it touched on the caller's change feed (M7-01): the
        # project tombstone, each now-unfiled task (an ordinary update) and each dropped link.
        recorder = ChangeRecorder(self.session, self.user_id)
        await recorder.record(
            ChangeEntityType.PROJECT, entity_id_for(project.id), ChangeOperation.DELETE
        )
        await recorder.record_many(
            (ChangeEntityType.TASK, entity_id_for(task_id), ChangeOperation.UPSERT)
            for task_id in unfiled
        )
        await recorder.record_many(
            (
                ChangeEntityType.NOTE_PROJECT_LINK,
                note_project_link_id(note_id, project.id),
                ChangeOperation.DELETE,
            )
            for note_id in unlinked
        )

    async def _record_change(self, entity_id: uuid.UUID, operation: ChangeOperation) -> None:
        """Announce a project change on the caller's personal change feed (M7-01)."""
        await ChangeRecorder(self.session, self.user_id).record(
            ChangeEntityType.PROJECT, entity_id_for(entity_id), operation
        )

    async def _remove_note_links(self, project_id: uuid.UUID) -> Sequence[uuid.UUID]:
        """Delete every ``note_projects`` row for the project, returning the linked note ids.

        A single bound ``DELETE`` keeps the tombstone atomic. The API never hard-deletes, so this
        explicit cleanup is what removes the links on the ordinary delete path; the
        ``note_projects.project_id`` foreign key's ``ON DELETE CASCADE`` covers the hard-delete
        paths (account deletion, a future retention purge). The note ids are returned so the caller
        can announce each removal on the change feed (M7-01).
        """
        note_ids = list(
            await self.session.scalars(
                select(NoteProject.note_id).where(NoteProject.project_id == project_id)
            )
        )
        await self.session.execute(delete(NoteProject).where(NoteProject.project_id == project_id))
        return note_ids

    async def _unfile_tasks(self, project_id: uuid.UUID) -> Sequence[uuid.UUID]:
        """Clear ``project_id`` on the project's live tasks and bump their revision.

        Scoped by ``user_id`` as well as ``project_id`` (defence in depth: a project id is unique,
        but every query in this module is user-scoped). A single bound ``UPDATE`` keeps the change
        atomic and never loads the tasks into the session. The affected task ids are read first and
        returned so the caller can announce each update on the change feed (M7-01).
        """
        task_ids = list(
            await self.session.scalars(
                select(Task.id).where(
                    Task.user_id == self.user_id,
                    Task.project_id == project_id,
                    Task.deleted_at.is_(None),
                )
            )
        )
        await self.session.execute(
            update(Task)
            .where(
                Task.user_id == self.user_id,
                Task.project_id == project_id,
                Task.deleted_at.is_(None),
            )
            .values(project_id=None, revision=Task.revision + 1)
        )
        return task_ids
