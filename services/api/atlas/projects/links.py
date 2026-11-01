"""Note↔project association (M4-05).

A note may be linked to any number of the caller's projects and a project lists any number of the
caller's notes (``DATA_MODEL.md`` §2.2/§2.3). The association lives in ``note_projects`` and is
optional; it is a *link*, not ownership, and it carries no payload.

Two properties matter and are enforced here:

- **The link references the note's stable id, never its path.** A rename changes ``notes.path`` but
  not ``notes.id`` (``MARKDOWN_STORAGE.md``), so a link survives a rename untouched. Nothing in
  this module looks at ``path`` for identity.
- **User scoping.** Both ends are resolved against the caller. Another user's project or note is
  indistinguishable from a missing one, so a client cannot probe for, or link across, another
  account's data.

This is the only writer of ``note_projects``. Linking is idempotent (a PostgreSQL
``ON CONFLICT DO NOTHING`` on the composite key), unlinking is idempotent, and the API's soft
deletes clear the link rows explicitly so no dangling association is left behind (the
``ON DELETE CASCADE`` keys cover the hard-delete paths).
"""

from __future__ import annotations

import uuid

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..changes import (
    ChangeEntityType,
    ChangeOperation,
    ChangeRecorder,
    note_project_link_id,
)
from ..models import NoteIndex, NoteProject, Project
from ..notes.service import NoteNotFoundError
from .service import ProjectsService

__all__ = ["NoteProjectLinks"]


class NoteProjectLinks:
    """Link/unlink and list the association between the caller's notes and projects."""

    def __init__(self, session: AsyncSession, user_id: uuid.UUID) -> None:
        self.session = session
        self.user_id = user_id

    # --- lookups --------------------------------------------------------

    async def _project(self, project_id: uuid.UUID) -> Project:
        """The caller's live project, or ``ProjectNotFoundError`` (also for another user's)."""
        return await ProjectsService(self.session, self.user_id).get(project_id)

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

    # --- mutations ------------------------------------------------------

    async def link(self, project_id: uuid.UUID, note_id: uuid.UUID) -> None:
        """Associate a note with a project. **Idempotent** — linking twice is a no-op.

        Both targets are validated first (unknown, another user's or deleted → the corresponding
        not-found error, with no row written), so a rejected link has no side effects.
        """
        project = await self._project(project_id)
        note = await self._note(note_id)
        result = await self.session.execute(
            pg_insert(NoteProject)
            .values(note_id=note.id, project_id=project.id)
            .on_conflict_do_nothing(index_elements=["note_id", "project_id"])
            .returning(NoteProject.note_id)
        )
        # Announce only a real change: a repeated link is a no-op and must not churn the feed.
        if result.first() is not None:
            await ChangeRecorder(self.session, self.user_id).record(
                ChangeEntityType.NOTE_PROJECT_LINK,
                note_project_link_id(note.id, project.id),
                ChangeOperation.UPSERT,
            )

    async def unlink(self, project_id: uuid.UUID, note_id: uuid.UUID) -> None:
        """Remove the association if it exists. **Idempotent** — an absent link is a no-op.

        Targets are validated first, so unlinking against an unknown/foreign/deleted note or
        project is reported as not found rather than silently ignored.
        """
        project = await self._project(project_id)
        note = await self._note(note_id)
        result = await self.session.execute(
            delete(NoteProject)
            .where(
                NoteProject.note_id == note.id,
                NoteProject.project_id == project.id,
            )
            .returning(NoteProject.note_id)
        )
        # Announce only a real change: unlinking an absent link is a no-op.
        if result.first() is not None:
            await ChangeRecorder(self.session, self.user_id).record(
                ChangeEntityType.NOTE_PROJECT_LINK,
                note_project_link_id(note.id, project.id),
                ChangeOperation.DELETE,
            )

    # --- listings -------------------------------------------------------

    async def notes(self, project_id: uuid.UUID) -> list[NoteIndex]:
        """The caller's live notes linked to one project, in path order.

        A tombstoned project is reported as not found. Tombstoned/deleted notes never appear (their
        links are removed on delete, and the join filters on ``deleted_at`` as defence in depth).
        """
        project = await self._project(project_id)
        rows = await self.session.scalars(
            select(NoteIndex)
            .join(NoteProject, NoteProject.note_id == NoteIndex.id)
            .where(
                NoteProject.project_id == project.id,
                NoteIndex.user_id == self.user_id,
                NoteIndex.deleted_at.is_(None),
            )
            .order_by(NoteIndex.path)
        )
        return list(rows)

    async def projects(self, note_id: uuid.UUID) -> list[Project]:
        """The caller's live projects linked to one note, in capture order.

        A tombstoned/deleted note is reported as not found. Tombstoned/deleted projects never
        appear (their links are removed on delete, and the join filters on ``deleted_at``).
        """
        note = await self._note(note_id)
        rows = await self.session.scalars(
            select(Project)
            .join(NoteProject, NoteProject.project_id == Project.id)
            .where(
                NoteProject.note_id == note.id,
                Project.user_id == self.user_id,
                Project.deleted_at.is_(None),
            )
            .order_by(Project.created_at, Project.id)
        )
        return list(rows)
