"""TTRPG prepared encounters and their slots (TTRPG-05)

Revision ID: c6a2f8b0d5e7
Revises: b5f1e7a9c4d6
Create Date: 2026-11-23

Adds ``ttrpg_encounters`` and ``ttrpg_encounter_slots``. Both start empty; no existing row changes.
Slots copy their stats from a creature card (``creature_id`` is ``SET NULL`` if the card ever goes)
so an encounter stays playable whatever happens to the catalogue or the card.

**Downgrade** drops both tables: every prepared encounter is lost (cards, party and notes stay).
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c6a2f8b0d5e7"
down_revision: str | None = "b5f1e7a9c4d6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NOW = sa.func.now()
_EMPTY_LIST = sa.text("'[]'::jsonb")
_EMPTY_OBJECT = sa.text("'{}'::jsonb")


def upgrade() -> None:
    op.create_table(
        "ttrpg_encounters",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("campaign_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("book_reference", sa.String(length=300), nullable=True),
        sa.Column("setup_reminder", sa.String(length=2000), nullable=True),
        sa.Column("session_id", sa.Uuid(), nullable=True),
        sa.Column("location_note_id", sa.Uuid(), nullable=True),
        sa.Column(
            "party_member_ids", postgresql.JSONB(), server_default=_EMPTY_LIST, nullable=False
        ),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revision", sa.Integer(), server_default="1", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.CheckConstraint("revision >= 1", name=op.f("ck_ttrpg_encounters_revision_positive")),
        sa.ForeignKeyConstraint(
            ["campaign_id"],
            ["ttrpg_campaigns.id"],
            name=op.f("fk_ttrpg_encounters_campaign_id_ttrpg_campaigns"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_ttrpg_encounters_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["session_id"],
            ["ttrpg_sessions.id"],
            name=op.f("fk_ttrpg_encounters_session_id_ttrpg_sessions"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["location_note_id"],
            ["notes.id"],
            name=op.f("fk_ttrpg_encounters_location_note_id_notes"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_ttrpg_encounters")),
    )
    op.create_index(op.f("ix_ttrpg_encounters_campaign_id"), "ttrpg_encounters", ["campaign_id"])
    op.create_index(op.f("ix_ttrpg_encounters_user_id"), "ttrpg_encounters", ["user_id"])
    op.create_index(op.f("ix_ttrpg_encounters_session_id"), "ttrpg_encounters", ["session_id"])
    op.create_table(
        "ttrpg_encounter_slots",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("encounter_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("side", sa.String(length=8), server_default="enemy", nullable=False),
        sa.Column("creature_id", sa.Uuid(), nullable=True),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("ac", sa.Integer(), nullable=False),
        sa.Column("hp", sa.Integer(), nullable=False),
        sa.Column("initiative_mod", sa.Integer(), server_default="0", nullable=False),
        sa.Column("overrides", postgresql.JSONB(), server_default=_EMPTY_LIST, nullable=False),
        sa.Column("snapshot", postgresql.JSONB(), server_default=_EMPTY_OBJECT, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.CheckConstraint(
            "side IN ('enemy','ally')", name=op.f("ck_ttrpg_encounter_slots_side_known")
        ),
        sa.CheckConstraint("ac >= 0", name=op.f("ck_ttrpg_encounter_slots_ac_nonneg")),
        sa.CheckConstraint("hp >= 1", name=op.f("ck_ttrpg_encounter_slots_hp_positive")),
        sa.ForeignKeyConstraint(
            ["encounter_id"],
            ["ttrpg_encounters.id"],
            name=op.f("fk_ttrpg_encounter_slots_encounter_id_ttrpg_encounters"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_ttrpg_encounter_slots_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["creature_id"],
            ["ttrpg_creatures.id"],
            name=op.f("fk_ttrpg_encounter_slots_creature_id_ttrpg_creatures"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_ttrpg_encounter_slots")),
        sa.UniqueConstraint("encounter_id", "position", name="uq_ttrpg_slots_encounter_position"),
    )
    op.create_index(
        op.f("ix_ttrpg_encounter_slots_encounter_id"), "ttrpg_encounter_slots", ["encounter_id"]
    )
    op.create_index(op.f("ix_ttrpg_encounter_slots_user_id"), "ttrpg_encounter_slots", ["user_id"])


def downgrade() -> None:
    op.drop_table("ttrpg_encounter_slots")
    op.drop_table("ttrpg_encounters")
