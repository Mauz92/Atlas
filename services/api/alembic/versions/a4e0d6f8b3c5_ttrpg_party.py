"""TTRPG party cards and play state (TTRPG-03)

Revision ID: a4e0d6f8b3c5
Revises: f2c8b4d6e1a3
Create Date: 2026-11-23

Adds ``ttrpg_party_members`` (cards) and ``ttrpg_party_state`` (one row per member). Both start
empty; no existing row changes.

**Downgrade** drops both tables: every party card and its play state is lost (campaigns, sessions
and notes stay).
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "a4e0d6f8b3c5"
down_revision: str | None = "f2c8b4d6e1a3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NOW = sa.func.now()
_EMPTY_LIST = sa.text("'[]'::jsonb")
_EMPTY_OBJECT = sa.text("'{}'::jsonb")


def upgrade() -> None:
    op.create_table(
        "ttrpg_party_members",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("campaign_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("role", sa.String(length=16), server_default="pc", nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("level", sa.Integer(), nullable=True),
        sa.Column("ac", sa.Integer(), nullable=False),
        sa.Column("max_hp", sa.Integer(), nullable=False),
        sa.Column("speed", sa.Integer(), nullable=True),
        sa.Column("initiative_mod", sa.Integer(), server_default="0", nullable=False),
        sa.Column("passive_perception", sa.Integer(), nullable=True),
        sa.Column("attacks", postgresql.JSONB(), server_default=_EMPTY_LIST, nullable=False),
        sa.Column("abilities", postgresql.JSONB(), server_default=_EMPTY_LIST, nullable=False),
        sa.Column("resources", postgresql.JSONB(), server_default=_EMPTY_LIST, nullable=False),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revision", sa.Integer(), server_default="1", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.CheckConstraint(
            "role IN ('pc','companion')", name=op.f("ck_ttrpg_party_members_role_known")
        ),
        sa.CheckConstraint("max_hp >= 1", name=op.f("ck_ttrpg_party_members_max_hp_positive")),
        sa.CheckConstraint("ac >= 0", name=op.f("ck_ttrpg_party_members_ac_nonneg")),
        sa.CheckConstraint("revision >= 1", name=op.f("ck_ttrpg_party_members_revision_positive")),
        sa.ForeignKeyConstraint(
            ["campaign_id"],
            ["ttrpg_campaigns.id"],
            name=op.f("fk_ttrpg_party_members_campaign_id_ttrpg_campaigns"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_ttrpg_party_members_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_ttrpg_party_members")),
    )
    op.create_index(
        op.f("ix_ttrpg_party_members_campaign_id"), "ttrpg_party_members", ["campaign_id"]
    )
    op.create_index(op.f("ix_ttrpg_party_members_user_id"), "ttrpg_party_members", ["user_id"])
    op.create_table(
        "ttrpg_party_state",
        sa.Column("member_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("current_hp", sa.Integer(), nullable=False),
        sa.Column("temp_hp", sa.Integer(), server_default="0", nullable=False),
        sa.Column("conditions", postgresql.JSONB(), server_default=_EMPTY_LIST, nullable=False),
        sa.Column("exhaustion_level", sa.Integer(), server_default="0", nullable=False),
        sa.Column("death_save_successes", sa.Integer(), server_default="0", nullable=False),
        sa.Column("death_save_failures", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "resources_used", postgresql.JSONB(), server_default=_EMPTY_OBJECT, nullable=False
        ),
        sa.Column("revision", sa.Integer(), server_default="1", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.CheckConstraint("current_hp >= 0", name=op.f("ck_ttrpg_party_state_current_hp_nonneg")),
        sa.CheckConstraint("temp_hp >= 0", name=op.f("ck_ttrpg_party_state_temp_hp_nonneg")),
        sa.CheckConstraint(
            "exhaustion_level BETWEEN 0 AND 6", name=op.f("ck_ttrpg_party_state_exhaustion_range")
        ),
        sa.CheckConstraint(
            "death_save_successes BETWEEN 0 AND 3",
            name=op.f("ck_ttrpg_party_state_death_successes_range"),
        ),
        sa.CheckConstraint(
            "death_save_failures BETWEEN 0 AND 3",
            name=op.f("ck_ttrpg_party_state_death_failures_range"),
        ),
        sa.CheckConstraint("revision >= 1", name=op.f("ck_ttrpg_party_state_revision_positive")),
        sa.ForeignKeyConstraint(
            ["member_id"],
            ["ttrpg_party_members.id"],
            name=op.f("fk_ttrpg_party_state_member_id_ttrpg_party_members"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_ttrpg_party_state_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("member_id", name=op.f("pk_ttrpg_party_state")),
    )
    op.create_index(op.f("ix_ttrpg_party_state_user_id"), "ttrpg_party_state", ["user_id"])


def downgrade() -> None:
    op.drop_table("ttrpg_party_state")
    op.drop_table("ttrpg_party_members")
