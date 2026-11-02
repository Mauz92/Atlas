"""Project table.

Projects are owned by PostgreSQL (``DATA_MODEL.md`` §2.3). The columns are exactly the
documented set — identity, owner, the descriptive fields and the sync fields. Progress is
**derived** from the project's tasks rather than stored, so there is no progress column
(the documented formula lives in ``atlas/projects/progress.py``, ADR-0023).

Tasks reference a project through ``tasks.project_id``; the foreign key is added by the same
migration and uses ``ON DELETE SET NULL`` so removing a project never removes its tasks
(ADR-0020).

``NoteProject`` (M4-05) is the note↔project association. Unlike a task's membership, a link is a
pure association row with no independent meaning, so both of its foreign keys cascade on a hard
delete (ADR-0024).
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from enum import StrEnum

from sqlalchemy import Date, DateTime, ForeignKey, Index, Integer, String, Text, Uuid, func, text
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base
from .base import TimestampMixin

#: The text-search expression the unified search (MU-05, ADR-0047) and ``ix_projects_search_fts``.
PROJECT_SEARCH_VECTOR = (
    "to_tsvector('simple'::regconfig, (COALESCE(name, ''::character varying)::text || ' '::text) "
    "|| COALESCE(description, ''::text))"
)


class ProjectStatus(StrEnum):
    """Lifecycle of a project. Kept deliberately small for the first milestone."""

    ACTIVE = "active"
    COMPLETED = "completed"
    ARCHIVED = "archived"


class Project(Base, TimestampMixin):
    __tablename__ = "projects"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(512), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
        default=ProjectStatus.ACTIVE.value,
        server_default=ProjectStatus.ACTIVE.value,
        index=True,
    )
    start_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    target_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        Index("ix_projects_search_fts", text(PROJECT_SEARCH_VECTOR), postgresql_using="gin"),
    )


class NoteProject(Base):
    """Association between a note and a project (M4-05).

    A note may be linked to any number of the caller's projects and a project to any number of
    notes; the association is optional and carries no payload beyond its ``created_at``. The
    composite primary key ``(note_id, project_id)`` makes it **unique per pair**, so linking twice
    cannot create a duplicate.

    It references the note's **stable id** (never its ``path``), so the link survives a rename
    (``MARKDOWN_STORAGE.md``): a rename changes ``notes.path`` but not ``notes.id``. Both foreign
    keys use ``ON DELETE CASCADE`` — a link has no meaning without both ends, so a *hard* delete of
    either side removes it, consistent with the existing ``task_links`` association note (ADR-0024).
    The API's ordinary delete path is a soft delete, so it clears the links explicitly rather than
    relying on the key (see ``atlas/projects/links.py``).
    """

    __tablename__ = "note_projects"

    note_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("notes.id", ondelete="CASCADE"), primary_key=True
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    # The composite primary key indexes ``note_id`` first; listing a *project's* notes filters by
    # ``project_id``, so that direction needs its own index.
    __table_args__ = (Index("ix_note_projects_project_id", "project_id"),)
