"""note history index (SYNC-04, ADR-0059 D5)

Revision ID: e7a3c5b1d9f2
Revises: d5e8a2f1c4b9
Create Date: 2026-11-03

Adds ``note_revisions``: one metadata row per retained revision of a note (hash, size, path,
reason). The content itself is a file under ``<notes-root>/.atlas/history/<note_id>/`` - the
database never holds note text. The table starts empty: a note's current revision is recorded
lazily by the first write that touches it (the file on disk is verified against the index hash
first), so no file is read here and the upgrade is metadata-only.

**Downgrade** drops the table. The history files stay on disk (harmless, inside the reserved
``.atlas`` directory that no listing, reconcile or backup filter touches) and are reused if the
migration is applied again only if the rows are re-created by new writes; they are never read
without a row.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e7a3c5b1d9f2"
down_revision: str | None = "d5e8a2f1c4b9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "note_revisions",
        sa.Column("note_id", sa.Uuid(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("content_hash", sa.String(length=64), nullable=False),
        sa.Column("size_bytes", sa.Integer(), server_default="0", nullable=False),
        sa.Column("path", sa.String(length=1024), nullable=False),
        sa.Column("reason", sa.String(length=16), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["note_id"], ["notes.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("note_id", "revision"),
    )
    op.create_index("ix_note_revisions_user_id", "note_revisions", ["user_id"])
    op.create_index("ix_note_revisions_created_at", "note_revisions", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_note_revisions_created_at", table_name="note_revisions")
    op.drop_index("ix_note_revisions_user_id", table_name="note_revisions")
    op.drop_table("note_revisions")
