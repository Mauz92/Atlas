"""Note index models.

Note *content* lives only on disk. These tables hold metadata, derived structure and the
full-text search vector, all of which can be rebuilt from the filesystem.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    Uuid,
    text,
)
from sqlalchemy.dialects.postgresql import TSVECTOR
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base
from .base import TimestampMixin


class NoteIndex(Base, TimestampMixin):
    __tablename__ = "notes"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    path: Mapped[str] = mapped_column(String(1024), nullable=False)
    title: Mapped[str] = mapped_column(String(512), nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    search_vector: Mapped[str | None] = mapped_column(TSVECTOR, nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        # Paths are unique among *live* notes only (SYNC-03c, ADR-0059 D3): a tombstone keeps its
        # row (and id) but no longer reserves the path, so another note may be created there.
        Index(
            "uq_notes_user_id_path_live",
            "user_id",
            "path",
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
        ),
        Index("ix_notes_search_vector", "search_vector", postgresql_using="gin"),
    )


class NoteLink(Base, TimestampMixin):
    __tablename__ = "note_links"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    source_note_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("notes.id", ondelete="CASCADE"), nullable=False, index=True
    )
    target_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    target_note_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("notes.id", ondelete="SET NULL"), nullable=True, index=True
    )
    link_text: Mapped[str | None] = mapped_column(String(512), nullable=True)


class Tag(Base, TimestampMixin):
    __tablename__ = "tags"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)

    __table_args__ = (UniqueConstraint("user_id", "name", name="uq_tags_user_id_name"),)


class NoteTag(Base):
    __tablename__ = "note_tags"

    note_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("notes.id", ondelete="CASCADE"), primary_key=True
    )
    tag_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True
    )
