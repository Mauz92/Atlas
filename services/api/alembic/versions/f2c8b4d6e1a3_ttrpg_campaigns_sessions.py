"""TTRPG campaigns and sessions (TTRPG-02)

Revision ID: f2c8b4d6e1a3
Revises: e1f7a3c9d5b2
Create Date: 2026-11-23

Adds ``ttrpg_campaigns`` and ``ttrpg_sessions``. Both start empty and no existing row changes. Notes
are referenced by id with ``ON DELETE SET NULL``; note rows are tombstoned, never hard-deleted by
Atlas, so the link is normally reported as "missing" rather than cleared.

**Downgrade** drops both tables: every campaign and session record is lost (the Markdown notes stay
on disk and in the notes table).
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f2c8b4d6e1a3"
down_revision: str | None = "e1f7a3c9d5b2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NOW = sa.func.now()


def upgrade() -> None:
    op.create_table(
        "ttrpg_campaigns",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column(
            "rules_preset", sa.String(length=32), server_default="dnd5e-2014", nullable=False
        ),
        sa.Column("book_title", sa.String(length=200), nullable=True),
        sa.Column("folder", sa.String(length=512), nullable=False),
        sa.Column("home_note_id", sa.Uuid(), nullable=True),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revision", sa.Integer(), server_default="1", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.CheckConstraint(
            "rules_preset IN ('dnd5e-2014')", name=op.f("ck_ttrpg_campaigns_rules_preset_known")
        ),
        sa.CheckConstraint("revision >= 1", name=op.f("ck_ttrpg_campaigns_revision_positive")),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_ttrpg_campaigns_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["home_note_id"],
            ["notes.id"],
            name=op.f("fk_ttrpg_campaigns_home_note_id_notes"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_ttrpg_campaigns")),
        sa.UniqueConstraint("user_id", "folder", name="uq_ttrpg_campaigns_user_folder"),
    )
    op.create_index(op.f("ix_ttrpg_campaigns_user_id"), "ttrpg_campaigns", ["user_id"])
    op.create_table(
        "ttrpg_sessions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("campaign_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("note_id", sa.Uuid(), nullable=True),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("session_date", sa.Date(), nullable=True),
        sa.Column("status", sa.String(length=16), server_default="planned", nullable=False),
        sa.Column("revision", sa.Integer(), server_default="1", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.CheckConstraint(
            "status IN ('planned','active','done')", name=op.f("ck_ttrpg_sessions_status_known")
        ),
        sa.CheckConstraint("sequence >= 1", name=op.f("ck_ttrpg_sessions_sequence_positive")),
        sa.CheckConstraint("revision >= 1", name=op.f("ck_ttrpg_sessions_revision_positive")),
        sa.ForeignKeyConstraint(
            ["campaign_id"],
            ["ttrpg_campaigns.id"],
            name=op.f("fk_ttrpg_sessions_campaign_id_ttrpg_campaigns"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_ttrpg_sessions_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["note_id"],
            ["notes.id"],
            name=op.f("fk_ttrpg_sessions_note_id_notes"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_ttrpg_sessions")),
        sa.UniqueConstraint("campaign_id", "sequence", name="uq_ttrpg_sessions_campaign_sequence"),
    )
    op.create_index(op.f("ix_ttrpg_sessions_campaign_id"), "ttrpg_sessions", ["campaign_id"])
    op.create_index(op.f("ix_ttrpg_sessions_user_id"), "ttrpg_sessions", ["user_id"])


def downgrade() -> None:
    op.drop_table("ttrpg_sessions")
    op.drop_table("ttrpg_campaigns")
