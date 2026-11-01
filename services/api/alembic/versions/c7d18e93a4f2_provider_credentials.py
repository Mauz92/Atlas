"""provider credentials

Revision ID: c7d18e93a4f2
Revises: f2a9c7d14b60
Create Date: 2026-10-26

Creates ``provider_credentials`` (M5-01): one encrypted OAuth credential per ``(user, provider)``.
The token material is stored as a single AES-256-GCM ciphertext sealed with a key held outside the
database (``Settings.token_encryption_key``); ``key_id`` records the key version so it can be
rotated. ``scopes``/``access_expires_at``/``refresh_expires_at`` are non-secret metadata. See
``DECISIONS.md`` ADR-0027.

The unique constraint on ``(user_id, provider)`` enforces the documented one-per-pair rule; it also
indexes ``user_id`` (leading column), so no separate index is created.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c7d18e93a4f2"
down_revision: str | None = "f2a9c7d14b60"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "provider_credentials",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("key_id", sa.String(length=64), nullable=False),
        sa.Column("ciphertext", sa.LargeBinary(), nullable=False),
        sa.Column(
            "scopes",
            sa.ARRAY(sa.Text()),
            server_default=sa.text("'{}'::text[]"),
            nullable=False,
        ),
        sa.Column("access_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("refresh_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_provider_credentials_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_provider_credentials")),
        sa.UniqueConstraint(
            "user_id", "provider", name=op.f("uq_provider_credentials_user_provider")
        ),
    )


def downgrade() -> None:
    op.drop_table("provider_credentials")
