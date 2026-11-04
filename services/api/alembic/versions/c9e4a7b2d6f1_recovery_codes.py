"""account recovery codes (AUTH-01, ADR-0067)

Revision ID: c9e4a7b2d6f1
Revises: b7c4d9e2a1f5
Create Date: 2026-11-04

Adds ``recovery_codes`` (at most one row per user; a salted HMAC-SHA-256 of the one-time code and
a diagnostic failure counter, never the code). The table starts empty: **existing accounts have no
recovery code** until the owner generates one in Settings after confirming the password. No
existing row changes.

**Downgrade** drops the table. Every recovery code then ceases to exist (a lost password can only
be reset with ``atlas-admin reset-password`` on the server until new codes are issued). Nothing
else is lost.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c9e4a7b2d6f1"
down_revision: str | None = "b7c4d9e2a1f5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "recovery_codes",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("code_salt", sa.String(length=32), nullable=False),
        sa.Column("code_hash", sa.String(length=64), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failed_attempts", sa.Integer(), server_default="0", nullable=False),
        sa.CheckConstraint(
            "failed_attempts >= 0", name=op.f("ck_recovery_codes_failed_attempts_nonneg")
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_recovery_codes_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("user_id", name=op.f("pk_recovery_codes")),
    )


def downgrade() -> None:
    op.drop_table("recovery_codes")
