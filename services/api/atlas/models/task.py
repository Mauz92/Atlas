"""Task tables.

Tasks are owned by PostgreSQL. This module defines the ``tasks`` table and the
task-side structures from ``DATA_MODEL.md`` §2.3 — note links, tag assignments and
recurrence series. ``project_id`` references ``projects.id`` with ``ON DELETE SET NULL``
(ADR-0020), so a task survives its project; ``reminder_policy_id`` references
``reminder_policies.id`` with ``ON DELETE SET NULL`` (M8-01), so a task survives the
deletion of its reminder preference.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from enum import StrEnum

from sqlalchemy import (
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base
from ..sync.fields import task_initial
from .base import TimestampMixin

#: The text-search expression the unified search (MU-05, ADR-0047) and ``ix_tasks_search_fts``.
#: Written as one literal so the query and the index are guaranteed to be the same expression.
TASK_SEARCH_VECTOR = (
    "to_tsvector('simple'::regconfig, (COALESCE(title, ''::character varying)::text || ' '::text) "
    "|| COALESCE(description, ''::text))"
)


class TaskStatus(StrEnum):
    INBOX = "inbox"
    NEXT = "next"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    ARCHIVED = "archived"


class TaskPriority(StrEnum):
    NONE = "none"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    URGENT = "urgent"


class Task(Base, TimestampMixin):
    __tablename__ = "tasks"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(512), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
        default=TaskStatus.INBOX.value,
        server_default=TaskStatus.INBOX.value,
        index=True,
    )
    priority: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
        default=TaskPriority.NONE.value,
        server_default=TaskPriority.NONE.value,
        index=True,
    )
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("projects.id", ondelete="SET NULL"), nullable=True
    )
    parent_task_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("tasks.id", ondelete="SET NULL"), nullable=True, index=True
    )
    start_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    due_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    time_zone: Mapped[str | None] = mapped_column(String(64), nullable=True)
    duration_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    recurrence_rule: Mapped[str | None] = mapped_column(Text, nullable=True)
    recurrence_parent_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("tasks.id", ondelete="SET NULL"), nullable=True
    )
    reminder_policy_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("reminder_policies.id", ondelete="SET NULL"), nullable=True
    )
    external_provider: Mapped[str | None] = mapped_column(String(32), nullable=True)
    external_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    #: field -> revision at which it last changed (SYNC-03, D4); see ``atlas.sync.fields``.
    field_revisions: Mapped[dict[str, int]] = mapped_column(
        JSONB, nullable=False, default=task_initial, server_default=text("'{}'::jsonb")
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        Index("ix_tasks_search_fts", text(TASK_SEARCH_VECTOR), postgresql_using="gin"),
    )


class RecurrenceSeries(Base, TimestampMixin):
    __tablename__ = "recurrence_series"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    rule: Mapped[str] = mapped_column(Text, nullable=False)
    dtstart: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    time_zone: Mapped[str | None] = mapped_column(String(64), nullable=True)
    end_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    recurrence_parent_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("tasks.id", ondelete="SET NULL"), nullable=True, index=True
    )


class TaskLink(Base):
    __tablename__ = "task_links"

    task_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("tasks.id", ondelete="CASCADE"), primary_key=True
    )
    # The primary key leads with ``task_id``; this index serves "which tasks link to this note".
    note_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("notes.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class TaskTag(Base):
    __tablename__ = "task_tags"

    task_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("tasks.id", ondelete="CASCADE"), primary_key=True
    )
    tag_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True
    )
