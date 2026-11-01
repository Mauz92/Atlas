"""per-user change feed store (change_log + users.change_seq)

Revision ID: d4e8b2c6f913
Revises: b7c2e1a9f4d0
Create Date: 2026-10-27

Adds the durable store behind ``GET /api/changes`` (M7-01, ADR-0032):

- ``change_log``: one row per changed entity, keyed ``(user_id, entity_type, entity_id)``, holding
  the entity's latest ``operation`` (``upsert``/``delete``) and a monotonic per-user cursor ``seq``.
  The composite primary key makes an entity appear once; ``uq_change_log_user_id_seq`` makes the
  cursor unique per user, so ordering by ``seq`` is a total order and paging cannot split a tie.
  ``user_id`` cascades on account deletion.
- ``users.change_seq`` (``bigint``, ``NOT NULL DEFAULT 0``): the per-user monotonic counter the
  recorder advances (``UPDATE users SET change_seq = change_seq + 1 … RETURNING``) in the same
  transaction as each mutation. The default ``0`` is backward compatible with existing rows.

Both are reversible: the downgrade drops the counter column and the table.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d4e8b2c6f913"
down_revision: str | None = "b7c2e1a9f4d0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("change_seq", sa.BigInteger(), nullable=False, server_default=sa.text("0")),
    )
    op.create_table(
        "change_log",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("entity_type", sa.String(length=32), nullable=False),
        sa.Column("entity_id", sa.String(length=128), nullable=False),
        sa.Column("operation", sa.String(length=16), nullable=False),
        sa.Column("seq", sa.BigInteger(), nullable=False),
        sa.Column(
            "changed_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_change_log_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("user_id", "entity_type", "entity_id", name=op.f("pk_change_log")),
        sa.UniqueConstraint("user_id", "seq", name="uq_change_log_user_id_seq"),
    )


def downgrade() -> None:
    op.drop_table("change_log")
    op.drop_column("users", "change_seq")
