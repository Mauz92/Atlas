"""calendar event projections and sync cursors

Revision ID: 9d2f4b6a1c37
Revises: c7d18e93a4f2
Create Date: 2026-10-27

Creates the M5-06 projection store (``DATA_MODEL.md`` §2.4, ``CALENDAR_SYNC.md`` §4):

- ``external_events`` — a read-only **projection** of a provider event, unique per
  ``(user_id, provider, external_event_id)``. A provider deletion is a tombstone
  (``deleted_at``), never a hard delete.
- ``sync_cursors`` — the durable incremental cursor per ``(user_id, provider, calendar_id)``,
  unique per that triple, with the last success/error state. ``cursor_value`` is advanced only in
  the same committed transaction as the changes it covers.

Both ``user_id`` foreign keys cascade on account deletion. See ``DECISIONS.md`` ADR-0029.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "9d2f4b6a1c37"
down_revision: str | None = "c7d18e93a4f2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "external_events",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("external_event_id", sa.String(length=512), nullable=False),
        sa.Column("calendar_id", sa.String(length=512), nullable=False),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("start_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("end_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("time_zone", sa.String(length=64), nullable=False),
        sa.Column("is_all_day", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("etag", sa.Text(), nullable=True),
        sa.Column("ical_uid", sa.Text(), nullable=True),
        sa.Column("recurrence_id", sa.Text(), nullable=True),
        sa.Column("recurrence_rule", sa.Text(), nullable=True),
        sa.Column("source_updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_synced_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
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
            name=op.f("fk_external_events_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_external_events")),
        sa.UniqueConstraint(
            "user_id",
            "provider",
            "external_event_id",
            name=op.f("uq_external_events_user_provider_external_event_id"),
        ),
    )

    op.create_table(
        "sync_cursors",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("calendar_id", sa.String(length=512), nullable=False),
        sa.Column("cursor_type", sa.String(length=16), nullable=False),
        sa.Column("cursor_value", sa.Text(), nullable=True),
        sa.Column("last_success_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("last_error_at", sa.DateTime(timezone=True), nullable=True),
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
            name=op.f("fk_sync_cursors_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_sync_cursors")),
        sa.UniqueConstraint(
            "user_id",
            "provider",
            "calendar_id",
            name=op.f("uq_sync_cursors_user_provider_calendar"),
        ),
    )


def downgrade() -> None:
    op.drop_table("sync_cursors")
    op.drop_table("external_events")
