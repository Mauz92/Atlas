"""note↔project association

Revision ID: f2a9c7d14b60
Revises: 8f1c2a7d5e04
Create Date: 2026-10-26

Creates ``note_projects`` (``DATA_MODEL.md`` §2.2/§2.3): the association between a note and a
project, keyed on the note's **stable id** so it survives a rename and never on its ``path``.

The composite primary key ``(note_id, project_id)`` makes the association unique per pair. Both
foreign keys use ``ON DELETE CASCADE``: a link has no meaning without both ends, and this mirrors
the existing ``task_links`` association (``note_id → notes.id`` and ``task_id → tasks.id`` are both
``CASCADE``). The API's ordinary delete path is a soft delete (tombstone), so it clears the link
rows explicitly rather than relying on the key; the key covers the hard-delete paths (account
deletion, a future retention purge). See ADR-0024.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f2a9c7d14b60"
down_revision: str | None = "8f1c2a7d5e04"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "note_projects",
        sa.Column("note_id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["note_id"],
            ["notes.id"],
            name=op.f("fk_note_projects_note_id_notes"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["projects.id"],
            name=op.f("fk_note_projects_project_id_projects"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("note_id", "project_id", name=op.f("pk_note_projects")),
    )
    op.create_index(
        op.f("ix_note_projects_project_id"), "note_projects", ["project_id"], unique=False
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_note_projects_project_id"), table_name="note_projects")
    op.drop_table("note_projects")
