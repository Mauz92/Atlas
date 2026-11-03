"""device credentials (SYNC-06, ADR-0059 D8, ADR-0065)

Revision ID: b7c4d9e2a1f5
Revises: f4a8b2c6d1e3
Create Date: 2026-11-03

Adds ``devices`` (one row per signed-in sync client; only the SHA-256 of its bearer token is
stored) and gives ``sync_resolutions.device_id`` (nullable, added by SYNC-05 without a foreign key)
its foreign key with ``ON DELETE SET NULL``. The table starts empty and every existing
``device_id`` is ``NULL``, so the upgrade changes no existing row.

**Downgrade** drops the foreign key and the table. That signs every device out (their tokens
cease to exist; they must register again) and clears ``sync_resolutions.device_id`` (which device
wrote an entry). Nothing else is lost. Back up first if device registrations matter.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b7c4d9e2a1f5"
down_revision: str | None = "f4a8b2c6d1e3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_PLATFORMS = "'windows','linux','macos','android','ios','web','other'"


def upgrade() -> None:
    op.create_table(
        "devices",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("platform", sa.String(length=16), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("prev_token_hash", sa.String(length=64), nullable=True),
        sa.Column("prev_valid_until", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(f"platform IN ({_PLATFORMS})", name=op.f("ck_devices_platform")),
        sa.CheckConstraint(
            "char_length(name) BETWEEN 1 AND 80", name=op.f("ck_devices_name_length")
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_devices_user_id_users"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_devices")),
    )
    op.create_index("uq_devices_token_hash", "devices", ["token_hash"], unique=True)
    op.create_index(
        "ix_devices_prev_token_hash",
        "devices",
        ["prev_token_hash"],
        postgresql_where=sa.text("prev_token_hash IS NOT NULL"),
    )
    op.create_index("ix_devices_user_id_created_at", "devices", ["user_id", "created_at"])
    op.create_foreign_key(
        op.f("fk_sync_resolutions_device_id_devices"),
        "sync_resolutions",
        "devices",
        ["device_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        op.f("fk_sync_resolutions_device_id_devices"), "sync_resolutions", type_="foreignkey"
    )
    # A device id means nothing without the table, and a later upgrade must be able to add the
    # foreign key again: clear the column (it was NULL before SYNC-06).
    op.execute("UPDATE sync_resolutions SET device_id = NULL")
    op.drop_table("devices")
