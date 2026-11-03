"""instance epoch for sync clients (SYNC-03b, ADR-0059 D9/D12)

Revision ID: c3b7d9e1f2a8
Revises: a1f0c3d2b4e6
Create Date: 2026-11-03

``instance_meta(key, value)`` with one row, ``epoch``: a random UUID that names this database's
history. Sync clients remember it and send it back; a different value means the server was restored
from a backup (the operator rotates it) or is another server, and the client must ask its user
before it syncs again. Created here so an install has an epoch from the start.

Reversible: the downgrade drops the table (a later upgrade creates a fresh epoch).
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c3b7d9e1f2a8"
down_revision: str | None = "a1f0c3d2b4e6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "instance_meta",
        sa.Column("key", sa.String(length=64), primary_key=True),
        sa.Column("value", sa.Text(), nullable=False),
    )
    op.execute(
        sa.text(
            "INSERT INTO instance_meta (key, value) VALUES ('epoch', gen_random_uuid()::text) "
            "ON CONFLICT (key) DO NOTHING"
        )
    )


def downgrade() -> None:
    op.drop_table("instance_meta")
