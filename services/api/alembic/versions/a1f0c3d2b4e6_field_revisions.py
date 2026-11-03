"""per-field revisions on tasks and projects (SYNC-03a, ADR-0059 D4)

Revision ID: a1f0c3d2b4e6
Revises: b7d3e1a95c24
Create Date: 2026-11-03

``tasks.field_revisions`` and ``projects.field_revisions`` (``jsonb NOT NULL DEFAULT '{}'``) map a
field name to the entity ``revision`` at which it last changed. They let a sync-mode ``PATCH`` ask
"did field ``f`` change after the client's base revision?" (SYNC_PROTOCOL.md section 6.2).

**Backfill.** Every existing row gets every tracked field set to its *current* revision, so an old
base can never merge silently across a change made before this migration (the history is unknown,
so it is treated as "changed at the current revision"). The backfill only touches rows whose
column is still the empty default, so re-running it (or running it after new rows were written by
the new code) changes nothing: it is idempotent. It rewrites no other column, bumps no revision and
records no change-feed row (a client has no reason to re-pull).

**Reversible.** The downgrade drops the two columns; nothing else depends on them.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "a1f0c3d2b4e6"
down_revision: str | None = "b7d3e1a95c24"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Frozen copies: a migration must not change meaning when the application's field list does.
_TASK_FIELDS = (
    "title",
    "description",
    "status",
    "priority",
    "project_id",
    "parent_task_id",
    "start_at",
    "due_at",
    "time_zone",
    "duration_minutes",
    "completed_at",
    "recurrence_rule",
    "recurrence_parent_id",
    "external_provider",
    "external_id",
    "tags",
)
_PROJECT_FIELDS = ("name", "description", "status", "start_date", "target_date")


def _backfill(table: str, fields: tuple[str, ...]) -> str:
    pairs = ", ".join(f"'{name}', revision" for name in fields)
    return (
        f"UPDATE {table} SET field_revisions = jsonb_build_object({pairs}) "
        "WHERE field_revisions = '{}'::jsonb"
    )


def upgrade() -> None:
    for table, fields in (("tasks", _TASK_FIELDS), ("projects", _PROJECT_FIELDS)):
        op.add_column(
            table,
            sa.Column(
                "field_revisions",
                postgresql.JSONB(astext_type=sa.Text()),
                nullable=False,
                server_default=sa.text("'{}'::jsonb"),
            ),
        )
        op.execute(sa.text(_backfill(table, fields)))


def downgrade() -> None:
    op.drop_column("projects", "field_revisions")
    op.drop_column("tasks", "field_revisions")
