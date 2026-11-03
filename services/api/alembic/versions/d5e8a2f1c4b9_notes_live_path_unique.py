"""unique note paths among live notes only (SYNC-03c, ADR-0059 D3)

Revision ID: d5e8a2f1c4b9
Revises: c3b7d9e1f2a8
Create Date: 2026-11-03

``uq_notes_user_id_path`` covered tombstones too, so a deleted note kept its path forever and a
*different* note (a client-generated id) could not be created there. It is replaced by a partial
unique index over live notes only: ``(user_id, path) WHERE deleted_at IS NULL``.

Upgrade only loosens a constraint, so no data can violate it. **Downgrade** restores the full
constraint; if a tombstone shares its path with a live note or another tombstone (possible only
after this revision), the tombstone's *index row* gets a unique ``[deleted <id>]`` suffix first so
the constraint can be created. That only touches the metadata of notes that are already deleted;
no file is read, written or removed.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d5e8a2f1c4b9"
down_revision: str | None = "c3b7d9e1f2a8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint("uq_notes_user_id_path", "notes", type_="unique")
    op.create_index(
        "uq_notes_user_id_path_live",
        "notes",
        ["user_id", "path"],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
    )


def downgrade() -> None:
    op.execute(
        sa.text(
            "UPDATE notes n SET path = left(n.path, 900) || ' [deleted ' || n.id::text || ']' "
            "WHERE n.deleted_at IS NOT NULL AND EXISTS ("
            "SELECT 1 FROM notes o "
            "WHERE o.user_id = n.user_id AND o.path = n.path AND o.id <> n.id)"
        )
    )
    op.drop_index("uq_notes_user_id_path_live", table_name="notes")
    op.create_unique_constraint("uq_notes_user_id_path", "notes", ["user_id", "path"])
