"""optional per-user feature switches (TTRPG-01)

Revision ID: e1f7a3c9d5b2
Revises: b7d4e1a8c5f3
Create Date: 2026-11-23

Adds ``user_features`` (one row per user and feature; a missing row means disabled). The table
starts empty, so **every existing account has every optional feature off**. No existing row changes.

**Downgrade** drops the table; every optional feature is then off again. Nothing else is lost.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e1f7a3c9d5b2"
down_revision: str | None = "b7d4e1a8c5f3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "user_features",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("feature", sa.String(length=32), nullable=False),
        sa.Column("enabled", sa.Boolean(), server_default="false", nullable=False),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_user_features_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("user_id", "feature", name=op.f("pk_user_features")),
    )


def downgrade() -> None:
    op.drop_table("user_features")
