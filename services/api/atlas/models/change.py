"""Per-user change feed store (M7-01).

``GET /api/changes`` lets a client that already holds a cursor ask for everything that changed
since, across the structured entities (tasks, projects, notes *metadata* and the note↔project
links), so it converges incrementally instead of re-fetching everything.

``ChangeLog`` is the durable store behind that feed (``DATA_MODEL.md`` §2.5). It holds **one row
per changed entity**, keyed by ``(user_id, entity_type, entity_id)``, recording the entity's
*latest* operation and a **monotonic per-user cursor** (``seq``):

- The row is **upserted** on every mutation, so an entity bumped twice between two client pulls
  appears exactly once, at its latest cursor — the feed is the current change state, not an
  append-only stream.
- ``operation`` is ``upsert`` for a create/update and ``delete`` for a soft delete (tombstone), so
  a client learns about deletions too. A ``delete`` row is retained until the retention window
  (M7-02) purges it, so a client can always resync from ``cursor=0`` while tombstones are kept.
- ``seq`` is allocated from the user's monotonic counter (``users.change_seq``) in the **same
  transaction** as the mutation, which is what makes the cursor ordering *provably* monotonic:
  two same-user recording transactions cannot interleave their cursors (see
  :class:`atlas.changes.record.ChangeRecorder` and ADR-0032).

``entity_id`` is a string so the feed can represent entities whose identity is not a single UUID: a
task/project/note uses the hex of its UUID, and a note↔project link uses the
``"{note_id}:{project_id}"`` pair. ``entity_type`` is a validated, small enumeration
(:class:`atlas.changes.feed.ChangeEntityType`).
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Index,
    String,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


class ChangeLog(Base):
    __tablename__ = "change_log"

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    entity_type: Mapped[str] = mapped_column(String(32), primary_key=True)
    entity_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    operation: Mapped[str] = mapped_column(String(16), nullable=False)
    seq: Mapped[int] = mapped_column(BigInteger, nullable=False)
    changed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        # The per-user cursor is unique: two change rows of the same user never share a cursor, so
        # ordering by ``seq`` is a total order and a page boundary cannot split a "tie" run.
        UniqueConstraint("user_id", "seq", name="uq_change_log_user_id_seq"),
        # Indexes the retention purge, which scans by age across all users (M7-02). The feed's own
        # ``(user_id, seq > since)`` scan is served by ``uq_change_log_user_id_seq``.
        Index("ix_change_log_changed_at", "changed_at"),
    )
