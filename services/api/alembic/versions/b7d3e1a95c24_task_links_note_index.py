"""task_links: index on note_id for "tasks linked to a note" (MU-06)

Revision ID: b7d3e1a95c24
Revises: a8c4d9e2b7f1
Create Date: 2026-11-02

The ``task_links`` table (task ↔ note, created in the tasks schema) is keyed ``(task_id, note_id)``,
so it already answers "which notes does a task link to". MU-06 adds the reverse question — "which
tasks link to this note", asked every time a note is opened — which would otherwise scan the table.
This migration only adds the supporting index; no column, row or constraint is touched, so it is
additive and the downgrade simply drops it.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "b7d3e1a95c24"
down_revision: str | None = "a8c4d9e2b7f1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index(op.f("ix_task_links_note_id"), "task_links", ["note_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_task_links_note_id"), table_name="task_links")
