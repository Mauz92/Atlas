"""calendar sources, OAuth state and event detail columns (M5-03/04/05/07/11, ADR-0071)

Revision ID: a6c3e9d27b14
Revises: e5b8f2a4c1d9
Create Date: 2026-11-10

Adds ``calendar_sources`` (one row per displayable calendar: a discovered Google/Microsoft calendar
or a secret ICS feed whose URL is stored sealed), ``oauth_states`` (single-use, session-bound OAuth
``state`` records), ``provider_credentials.needs_reauth_at`` and four detail columns plus a range
index on ``external_events``. Every new column is nullable or defaulted, so existing rows and the
previous release keep working.

**Downgrade** drops the two tables (every ICS feed URL, calendar choice and pending OAuth flow is
lost; connected accounts stay and are rediscovered on the next sync), the index and the columns
(event location/description/link and series ids are lost; the next full sync repopulates them).
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a6c3e9d27b14"
down_revision: str | None = "e5b8f2a4c1d9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "calendar_sources",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("external_id", sa.String(length=512), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("color", sa.String(length=16), nullable=True),
        sa.Column("time_zone", sa.String(length=64), nullable=False),
        sa.Column("is_read_only", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("is_primary", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("selected", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("feed_url_ciphertext", sa.LargeBinary(), nullable=True),
        sa.Column("feed_url_key_id", sa.String(length=64), nullable=True),
        sa.Column("feed_url_display", sa.Text(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id", "provider", "external_id", name="uq_calendar_sources_user_provider_external"
        ),
    )
    op.create_table(
        "oauth_states",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("state_hash", sa.String(length=64), nullable=False),
        sa.Column("session_hash", sa.String(length=64), nullable=False),
        sa.Column("verifier_ciphertext", sa.LargeBinary(), nullable=False),
        sa.Column("key_id", sa.String(length=64), nullable=False),
        sa.Column("redirect_uri", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("state_hash"),
    )
    op.create_index("ix_oauth_states_expires_at", "oauth_states", ["expires_at"])
    op.add_column(
        "provider_credentials",
        sa.Column("needs_reauth_at", sa.DateTime(timezone=True), nullable=True),
    )
    for column in ("location", "description", "web_link", "series_id"):
        op.add_column("external_events", sa.Column(column, sa.Text(), nullable=True))
    op.create_index(
        "ix_external_events_user_range", "external_events", ["user_id", "start_at", "end_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_external_events_user_range", table_name="external_events")
    for column in ("series_id", "web_link", "description", "location"):
        op.drop_column("external_events", column)
    op.drop_column("provider_credentials", "needs_reauth_at")
    op.drop_index("ix_oauth_states_expires_at", table_name="oauth_states")
    op.drop_table("oauth_states")
    op.drop_table("calendar_sources")
