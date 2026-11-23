"""TTRPG combat runs, combatants and action history (TTRPG-06)

Revision ID: d7b3a9c1e6f8
Revises: c6a2f8b0d5e7
Create Date: 2026-11-23

Adds ``ttrpg_combat_runs`` (with a partial unique index: one unfinished run per campaign),
``ttrpg_combatants`` and ``ttrpg_combat_actions`` (unique ``(run_id, seq)`` and
``(run_id, mutation_key)``). All start empty; no existing row changes.

**Downgrade** drops the three tables: every combat run and its history is lost (the party's play
state, which combat writes to, stays as it was).
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "d7b3a9c1e6f8"
down_revision: str | None = "c6a2f8b0d5e7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NOW = sa.func.now()
_EMPTY_LIST = sa.text("'[]'::jsonb")
_EMPTY_OBJECT = sa.text("'{}'::jsonb")


def upgrade() -> None:
    op.create_table(
        "ttrpg_combat_runs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("campaign_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("session_id", sa.Uuid(), nullable=True),
        sa.Column("encounter_id", sa.Uuid(), nullable=True),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("status", sa.String(length=8), server_default="setup", nullable=False),
        sa.Column("round", sa.Integer(), server_default="0", nullable=False),
        sa.Column("active_combatant_id", sa.Uuid(), nullable=True),
        sa.Column(
            "encounter_snapshot", postgresql.JSONB(), server_default=_EMPTY_OBJECT, nullable=False
        ),
        sa.Column("outcome", sa.String(length=2000), nullable=True),
        sa.Column("end_reason", sa.String(length=32), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revision", sa.Integer(), server_default="1", nullable=False),
        sa.Column("action_seq", sa.Integer(), server_default="0", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.CheckConstraint(
            "status IN ('setup','active','paused','ended')",
            name=op.f("ck_ttrpg_combat_runs_status_known"),
        ),
        sa.CheckConstraint("round >= 0", name=op.f("ck_ttrpg_combat_runs_round_nonneg")),
        sa.CheckConstraint("revision >= 1", name=op.f("ck_ttrpg_combat_runs_revision_positive")),
        sa.ForeignKeyConstraint(
            ["campaign_id"],
            ["ttrpg_campaigns.id"],
            name=op.f("fk_ttrpg_combat_runs_campaign_id_ttrpg_campaigns"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_ttrpg_combat_runs_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["session_id"],
            ["ttrpg_sessions.id"],
            name=op.f("fk_ttrpg_combat_runs_session_id_ttrpg_sessions"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["encounter_id"],
            ["ttrpg_encounters.id"],
            name=op.f("fk_ttrpg_combat_runs_encounter_id_ttrpg_encounters"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_ttrpg_combat_runs")),
    )
    op.create_index(op.f("ix_ttrpg_combat_runs_campaign_id"), "ttrpg_combat_runs", ["campaign_id"])
    op.create_index(op.f("ix_ttrpg_combat_runs_user_id"), "ttrpg_combat_runs", ["user_id"])
    op.create_index(
        "uq_ttrpg_combat_runs_one_unfinished",
        "ttrpg_combat_runs",
        ["campaign_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('setup','active','paused')"),
    )

    op.create_table(
        "ttrpg_combatants",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=8), nullable=False),
        sa.Column("side", sa.String(length=8), nullable=False),
        sa.Column("party_member_id", sa.Uuid(), nullable=True),
        sa.Column("source_slot_id", sa.Uuid(), nullable=True),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("ac", sa.Integer(), nullable=False),
        sa.Column("max_hp", sa.Integer(), nullable=False),
        sa.Column("hp", sa.Integer(), nullable=True),
        sa.Column("temp_hp", sa.Integer(), nullable=True),
        sa.Column("conditions", postgresql.JSONB(), server_default=_EMPTY_LIST, nullable=False),
        sa.Column(
            "condition_reminders", postgresql.JSONB(), server_default=_EMPTY_OBJECT, nullable=False
        ),
        sa.Column("initiative_mod", sa.Integer(), server_default="0", nullable=False),
        sa.Column("initiative", sa.Integer(), nullable=True),
        sa.Column("order_index", sa.Integer(), nullable=True),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("defeated", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("removed", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("snapshot", postgresql.JSONB(), server_default=_EMPTY_OBJECT, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.CheckConstraint("kind IN ('npc','party')", name=op.f("ck_ttrpg_combatants_kind_known")),
        sa.CheckConstraint(
            "side IN ('enemy','ally','party')", name=op.f("ck_ttrpg_combatants_side_known")
        ),
        sa.CheckConstraint(
            "(kind = 'npc') = (hp IS NOT NULL)", name=op.f("ck_ttrpg_combatants_npc_owns_hp")
        ),
        sa.CheckConstraint("max_hp >= 1", name=op.f("ck_ttrpg_combatants_max_hp_positive")),
        sa.ForeignKeyConstraint(
            ["run_id"],
            ["ttrpg_combat_runs.id"],
            name=op.f("fk_ttrpg_combatants_run_id_ttrpg_combat_runs"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_ttrpg_combatants_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["party_member_id"],
            ["ttrpg_party_members.id"],
            name=op.f("fk_ttrpg_combatants_party_member_id_ttrpg_party_members"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_ttrpg_combatants")),
    )
    op.create_index(op.f("ix_ttrpg_combatants_run_id"), "ttrpg_combatants", ["run_id"])
    op.create_index(op.f("ix_ttrpg_combatants_user_id"), "ttrpg_combatants", ["user_id"])

    op.create_table(
        "ttrpg_combat_actions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=24), nullable=False),
        sa.Column("mutation_key", sa.String(length=64), nullable=False),
        sa.Column("request_hash", sa.String(length=64), nullable=False),
        sa.Column("combatant_id", sa.Uuid(), nullable=True),
        sa.Column("summary", sa.String(length=500), nullable=False),
        sa.Column("reversible", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("before", postgresql.JSONB(), server_default=_EMPTY_OBJECT, nullable=False),
        sa.Column("after", postgresql.JSONB(), server_default=_EMPTY_OBJECT, nullable=False),
        sa.Column("undone_by_seq", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.ForeignKeyConstraint(
            ["run_id"],
            ["ttrpg_combat_runs.id"],
            name=op.f("fk_ttrpg_combat_actions_run_id_ttrpg_combat_runs"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_ttrpg_combat_actions_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_ttrpg_combat_actions")),
        sa.UniqueConstraint("run_id", "seq", name="uq_ttrpg_actions_run_seq"),
        sa.UniqueConstraint("run_id", "mutation_key", name="uq_ttrpg_actions_run_key"),
    )
    op.create_index(op.f("ix_ttrpg_combat_actions_run_id"), "ttrpg_combat_actions", ["run_id"])
    op.create_index(op.f("ix_ttrpg_combat_actions_user_id"), "ttrpg_combat_actions", ["user_id"])


def downgrade() -> None:
    op.drop_table("ttrpg_combat_actions")
    op.drop_table("ttrpg_combatants")
    op.drop_table("ttrpg_combat_runs")
