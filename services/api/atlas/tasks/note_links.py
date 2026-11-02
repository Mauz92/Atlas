"""Task↔note association (MU-06).

A task may link to any number of the caller's notes and a note lists any number of tasks. The
association lives in ``task_links`` and is a *link*, not ownership: notes stay authoritative as
Markdown files and tasks as database rows (``AGENTS.md`` §7.2, §8). Markdown checkboxes are never
parsed into tasks; a link is created only by the explicit "task from a note" action.

Properties enforced here:

- **The link references the note's stable id, never its path**, so a rename (which changes
  ``notes.path`` only) leaves it intact.
- **User scoping.** Both ends are resolved against the caller; another user's task or note is
  indistinguishable from a missing one.
- **Atomic create.** :meth:`TaskNoteLinks.create_task` validates the note, creates the task and
  writes the link in the caller's transaction, so a failed request leaves neither.
- **Idempotent.** The link insert is ``ON CONFLICT DO NOTHING`` and unlinking an absent link is a
  no-op; only a real change is announced on the change feed. Retried *creation* is made idempotent
  at the API with an ``Idempotency-Key`` (same mechanism as ``POST /api/tasks``).
- **Tombstones.** Listings hide deleted tasks and notes. The link row of a soft-deleted task or note
  is kept, so restoring one (undo, or a note file that reappears) restores the link; the
  ``ON DELETE CASCADE`` keys cover hard deletes.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..changes import ChangeEntityType, ChangeOperation, ChangeRecorder, task_note_link_id
from ..models import NoteIndex, NoteProject, Project, Task, TaskLink, TaskStatus
from ..notes.service import NoteNotFoundError
from .service import TasksService

__all__ = ["TaskNoteLinks"]

_CLOSED = (TaskStatus.COMPLETED, TaskStatus.ARCHIVED)


class TaskNoteLinks:
    """Create, list and remove the association between the caller's tasks and notes."""

    def __init__(self, session: AsyncSession, user_id: uuid.UUID) -> None:
        self.session = session
        self.user_id = user_id

    async def _note(self, note_id: uuid.UUID) -> NoteIndex:
        """The caller's live note, or ``NoteNotFoundError`` (also for another user's/deleted)."""
        note = await self.session.scalar(
            select(NoteIndex).where(
                NoteIndex.id == note_id,
                NoteIndex.user_id == self.user_id,
                NoteIndex.deleted_at.is_(None),
            )
        )
        if note is None:
            raise NoteNotFoundError(str(note_id))
        return note

    async def create_task(self, note_id: uuid.UUID, data: Mapping[str, Any]) -> Task:
        """Create a task from a note and link it; the note is checked before anything is written."""
        note = await self._note(note_id)
        task = await TasksService(self.session, self.user_id).create(data)
        await self.session.execute(
            pg_insert(TaskLink)
            .values(task_id=task.id, note_id=note.id)
            .on_conflict_do_nothing(index_elements=["task_id", "note_id"])
        )
        await self._record(task.id, note.id, ChangeOperation.UPSERT)
        return task

    async def unlink(self, task_id: uuid.UUID, note_id: uuid.UUID) -> None:
        """Remove the association if it exists (idempotent). Unknown/foreign targets are 404."""
        task = await TasksService(self.session, self.user_id).get(task_id)
        note = await self._note(note_id)
        result = await self.session.execute(
            delete(TaskLink)
            .where(TaskLink.task_id == task.id, TaskLink.note_id == note.id)
            .returning(TaskLink.task_id)
        )
        if result.first() is not None:
            await self._record(task.id, note.id, ChangeOperation.DELETE)

    async def notes_for_task(self, task_id: uuid.UUID) -> list[NoteIndex]:
        """The caller's live notes linked to one task, in path order."""
        task = await TasksService(self.session, self.user_id).get(task_id)
        rows = await self.session.scalars(
            select(NoteIndex)
            .join(TaskLink, TaskLink.note_id == NoteIndex.id)
            .where(
                TaskLink.task_id == task.id,
                NoteIndex.user_id == self.user_id,
                NoteIndex.deleted_at.is_(None),
            )
            .order_by(NoteIndex.path)
        )
        return list(rows)

    async def tasks_for_note(self, note_id: uuid.UUID) -> list[Task]:
        """The caller's live tasks linked to one note: open work first, then by capture time."""
        rows = await self.session.scalars(
            select(Task)
            .join(TaskLink, TaskLink.task_id == Task.id)
            .where(
                TaskLink.note_id == note_id,
                Task.user_id == self.user_id,
                Task.deleted_at.is_(None),
            )
            .order_by(Task.status.in_(_CLOSED), Task.created_at, Task.id)
        )
        return list(rows)

    async def projects_for_note(self, note_id: uuid.UUID) -> list[Project]:
        """The caller's live projects linked to one note (``note_projects``), oldest first."""
        rows = await self.session.scalars(
            select(Project)
            .join(NoteProject, NoteProject.project_id == Project.id)
            .where(
                NoteProject.note_id == note_id,
                Project.user_id == self.user_id,
                Project.deleted_at.is_(None),
            )
            .order_by(Project.created_at, Project.id)
        )
        return list(rows)

    async def _record(self, task_id: uuid.UUID, note_id: uuid.UUID, op: ChangeOperation) -> None:
        await ChangeRecorder(self.session, self.user_id).record(
            ChangeEntityType.TASK_NOTE_LINK, task_note_link_id(task_id, note_id), op
        )
