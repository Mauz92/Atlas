"""TTRPG creature cards (TTRPG-04)

Revision ID: b5f1e7a9c4d6
Revises: a4e0d6f8b3c5
Create Date: 2026-11-23

Adds ``ttrpg_creatures``: manual cards, SRD imports (with source edition, external id and
attribution) and editable variants. Starts empty; no existing row changes. A partial unique index
makes a repeated import of the same SRD creature a no-op per owner.

**Downgrade** drops the table: every creature card is lost.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "b5f1e7a9c4d6"
down_revision: str | None = "a4e0d6f8b3c5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NOW = sa.func.now()
_EMPTY_LIST = sa.text("'[]'::jsonb")


def upgrade() -> None:
    op.create_table(
        "ttrpg_creatures",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("ac", sa.Integer(), nullable=False),
        sa.Column("hp", sa.Integer(), nullable=False),
        sa.Column("speed", sa.String(length=200), nullable=True),
        sa.Column("initiative_mod", sa.Integer(), server_default="0", nullable=False),
        sa.Column("challenge_rating", sa.String(length=8), nullable=True),
        sa.Column("size", sa.String(length=32), nullable=True),
        sa.Column("creature_type", sa.String(length=120), nullable=True),
        sa.Column("traits", postgresql.JSONB(), server_default=_EMPTY_LIST, nullable=False),
        sa.Column("actions", postgresql.JSONB(), server_default=_EMPTY_LIST, nullable=False),
        sa.Column("source", sa.String(length=16), server_default="manual", nullable=False),
        sa.Column("source_edition", sa.String(length=16), nullable=True),
        sa.Column("external_id", sa.String(length=100), nullable=True),
        sa.Column("attribution", sa.String(length=1000), nullable=True),
        sa.Column("imported_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("derived_from_id", sa.Uuid(), nullable=True),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revision", sa.Integer(), server_default="1", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.CheckConstraint(
            "source IN ('manual','srd')", name=op.f("ck_ttrpg_creatures_source_known")
        ),
        sa.CheckConstraint(
            "(source = 'srd') = (external_id IS NOT NULL)",
            name=op.f("ck_ttrpg_creatures_external_id_matches_source"),
        ),
        sa.CheckConstraint("ac >= 0", name=op.f("ck_ttrpg_creatures_ac_nonneg")),
        sa.CheckConstraint("hp >= 1", name=op.f("ck_ttrpg_creatures_hp_positive")),
        sa.CheckConstraint("revision >= 1", name=op.f("ck_ttrpg_creatures_revision_positive")),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_ttrpg_creatures_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["derived_from_id"],
            ["ttrpg_creatures.id"],
            name=op.f("fk_ttrpg_creatures_derived_from_id_ttrpg_creatures"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_ttrpg_creatures")),
    )
    op.create_index(op.f("ix_ttrpg_creatures_user_id"), "ttrpg_creatures", ["user_id"])
    op.create_index(
        "uq_ttrpg_creatures_user_srd",
        "ttrpg_creatures",
        ["user_id", "source_edition", "external_id"],
        unique=True,
        postgresql_where=sa.text("source = 'srd'"),
    )


def downgrade() -> None:
    op.drop_table("ttrpg_creatures")
