"""change-feed retention: purge floor + changed_at index (M7-02)

Revision ID: c1a2b3d4e5f6
Revises: d4e8b2c6f913
Create Date: 2026-10-27

Bounds the per-user change feed's history (M7-02, ADR-0033):

- ``users.change_purge_floor`` (``bigint NOT NULL DEFAULT 0``): the highest change-feed cursor the
  retention purge has removed for the user. Every change with ``seq <= change_purge_floor`` is no
  longer deliverable, so the feed answers ``resync_required`` for a client whose ``since`` is below
  it. It starts at ``0`` (nothing purged), so it is backward compatible with existing rows, and it
  is monotonic — a purge only ever raises it.
- ``ix_change_log_changed_at`` on ``change_log(changed_at)``: indexes the purge, which selects rows
  by age across all users. The feed's own per-user ``(user_id, seq)`` scan is already served by
  ``uq_change_log_user_id_seq``.

Neither change touches user data: the purge the column supports only ever removes ``change_log``
rows, never a task, project or note row. Both directions are reversible.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c1a2b3d4e5f6"
down_revision: str | None = "d4e8b2c6f913"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "change_purge_floor",
            sa.BigInteger(),
            nullable=False,
            server_default=sa.text("0"),
        ),
    )
    op.create_index("ix_change_log_changed_at", "change_log", ["changed_at"])


def downgrade() -> None:
    op.drop_index("ix_change_log_changed_at", table_name="change_log")
    op.drop_column("users", "change_purge_floor")
