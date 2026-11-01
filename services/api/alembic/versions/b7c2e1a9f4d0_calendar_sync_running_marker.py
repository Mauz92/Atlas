"""calendar sync running marker (sync_cursors.sync_started_at)

Revision ID: b7c2e1a9f4d0
Revises: 9d2f4b6a1c37
Create Date: 2026-10-27

Adds the durable running/``in_progress`` marker for a calendar sync run (M5-10, ADR-0031). The
column lives on the existing ``sync_cursors`` row rather than a new table, so the M5-08 sync-status
read stays a **derived** view of the same rows and never becomes a parallel source of truth.

``sync_started_at`` is set (and committed) when a scheduled/reconciled run begins for a
``(user, provider, calendar)`` and cleared when the run ends. It is nullable and its default is
``NULL``, so the migration is backward compatible with existing rows (a pre-M5-10 row simply has no
run in progress).
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b7c2e1a9f4d0"
down_revision: str | None = "9d2f4b6a1c37"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "sync_cursors",
        sa.Column("sync_started_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("sync_cursors", "sync_started_at")
