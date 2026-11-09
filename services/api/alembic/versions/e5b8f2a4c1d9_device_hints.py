"""per-device sync-hint destinations (M8-04e, ADR-0068)

Revision ID: e5b8f2a4c1d9
Revises: d3a5c8e1b7f2
Create Date: 2026-11-04

Adds ``device_hints`` (at most one row per device; ``ON DELETE CASCADE`` from ``devices``): the
registered UnifiedPush endpoint (encrypted at rest, bound to the device id), delivery diagnostics
(``last_ok_at``, a short ``last_error_class``, a failure count) and ``invalid_at``. The table starts
empty and nothing is sent while ``SYNC_HINT_ENABLED`` is false, so existing installations are
unchanged.

**Downgrade** drops the table: every registered hint destination is lost (a device registers again
when it next runs); nothing else changes.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e5b8f2a4c1d9"
down_revision: str | None = "d3a5c8e1b7f2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "device_hints",
        sa.Column("device_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("endpoint_encrypted", sa.LargeBinary(), nullable=False),
        sa.Column("key_id", sa.String(length=32), nullable=False),
        sa.Column("endpoint_tail", sa.String(length=4), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("last_ok_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error_class", sa.String(length=32), nullable=True),
        sa.Column("failures", sa.Integer(), server_default="0", nullable=False),
        sa.Column("invalid_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["device_id"],
            ["devices.id"],
            name=op.f("fk_device_hints_device_id_devices"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("device_id", name=op.f("pk_device_hints")),
    )


def downgrade() -> None:
    op.drop_table("device_hints")
