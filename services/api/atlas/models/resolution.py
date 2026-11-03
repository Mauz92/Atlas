"""The automatic-resolution log (SYNC-05, ADR-0059 D7, ADR-0061; ``SYNC_PROTOCOL.md`` section 9).

One row per *automatic* decision the server took while applying a sync-mode write (a simple field
where the later write won, a delete that lost to an edit, a merged note, a renamed path), plus one
row per undo. Rows are written in the **same transaction** as the write that caused them and are
announced on the change feed as the ``resolution`` entity.

Privacy rule (SECURITY.md): ``loser`` holds the overwritten value of a *simple* field only (a
status, a priority, a date, a path). Task and project text and note content are never copied here:
for those the entry points to the entity's history or conflict copy. Rows are purged after the
change-retention window (90 days by default) together with their feed rows.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base

#: every rule the log can hold (kept in step with ``atlas.sync.resolution_rules.RULES``)
_RULES = (
    "'simple_later_wins','edit_wins_over_delete','note_merged','path_collision',"
    "'path_later_wins','undo'"
)


class SyncResolution(Base):
    __tablename__ = "sync_resolutions"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    #: ``task`` | ``project`` | ``note`` (the entity the decision was about)
    entity_type: Mapped[str] = mapped_column(String(16), nullable=False)
    entity_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    rule: Mapped[str] = mapped_column(String(32), nullable=False)
    #: the simple field the decision was about (``path`` for a note move), ``None`` otherwise
    field: Mapped[str | None] = mapped_column(String(64))
    #: the entity revision the winning write was stored at (for ``note_merged``: the revision whose
    #: text the edit was merged into, see SYNC_PROTOCOL.md section 9)
    kept_revision: Mapped[int | None] = mapped_column(Integer)
    #: the overwritten value of a simple field, JSON; ``None`` for every other rule. For an
    #: ``undo`` entry: the value the undo replaced.
    loser: Mapped[Any | None] = mapped_column(JSONB(none_as_null=True))
    #: short machine-written explanation (paths only, never text), bounded
    detail: Mapped[str | None] = mapped_column(String(2048))
    #: the device that sent the write (SYNC-06); ``NULL`` for a browser session, and for a device
    #: that was purged after revocation
    device_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("devices.id", ondelete="SET NULL")
    )
    #: the ``Idempotency-Key`` of the causing request and the position within it: the tripwire that
    #: makes "a retry logs nothing more" a database fact, not only a code path
    op_key: Mapped[str | None] = mapped_column(String(200))
    ordinal: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, default=0, server_default="0"
    )
    #: for an ``undo`` entry: the resolution it undid; at most one undo entry per resolution
    undoes_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("sync_resolutions.id", ondelete="SET NULL")
    )
    #: set when the resolution was undone, with the undo entry that did it
    undone_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    undone_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("sync_resolutions.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        CheckConstraint(f"rule IN ({_RULES})", name="rule"),
        CheckConstraint("entity_type IN ('task','project','note')", name="entity_type"),
        Index("ix_sync_resolutions_user_id_created_at", "user_id", "created_at", "ordinal", "id"),
        Index("ix_sync_resolutions_user_id_entity_id", "user_id", "entity_id"),
        Index("ix_sync_resolutions_created_at", "created_at"),
        Index(
            "uq_sync_resolutions_op",
            "user_id",
            "op_key",
            "ordinal",
            unique=True,
            postgresql_where=text("op_key IS NOT NULL"),
        ),
        Index(
            "uq_sync_resolutions_undoes_id",
            "undoes_id",
            unique=True,
            postgresql_where=text("undoes_id IS NOT NULL"),
        ),
    )
