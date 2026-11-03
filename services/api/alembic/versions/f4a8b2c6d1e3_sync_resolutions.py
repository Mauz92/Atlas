"""automatic-resolution log (SYNC-05, ADR-0059 D7, ADR-0061)

Revision ID: f4a8b2c6d1e3
Revises: e7a3c5b1d9f2
Create Date: 2026-11-03

Adds ``sync_resolutions``: one row per automatic decision of a sync-mode write (and one per undo),
written in the same transaction as the write and announced on the change feed as the ``resolution``
entity. The table starts empty: nothing is backfilled (resolutions made before this revision were
response-only and are not recoverable), so the upgrade is metadata-only and touches no existing row.

**Downgrade** drops the table and deletes the ``resolution`` rows from ``change_log`` (an older
server does not know the entity type and must not announce it). That loses the log - the
overwritten simple-field values and the undo state - and nothing else: tasks, projects and notes
are untouched. Back up first if the log matters.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "f4a8b2c6d1e3"
down_revision: str | None = "e7a3c5b1d9f2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_RULES = (
    "'simple_later_wins','edit_wins_over_delete','note_merged','path_collision',"
    "'path_later_wins','undo'"
)


def upgrade() -> None:
    op.create_table(
        "sync_resolutions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("entity_type", sa.String(length=16), nullable=False),
        sa.Column("entity_id", sa.Uuid(), nullable=False),
        sa.Column("rule", sa.String(length=32), nullable=False),
        sa.Column("field", sa.String(length=64), nullable=True),
        sa.Column("kept_revision", sa.Integer(), nullable=True),
        sa.Column("loser", postgresql.JSONB(none_as_null=True), nullable=True),
        sa.Column("detail", sa.String(length=2048), nullable=True),
        sa.Column("device_id", sa.Uuid(), nullable=True),
        sa.Column("op_key", sa.String(length=200), nullable=True),
        sa.Column("ordinal", sa.SmallInteger(), server_default="0", nullable=False),
        sa.Column("undoes_id", sa.Uuid(), nullable=True),
        sa.Column("undone_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("undone_by", sa.Uuid(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(f"rule IN ({_RULES})", name=op.f("ck_sync_resolutions_rule")),
        sa.CheckConstraint(
            "entity_type IN ('task','project','note')",
            name=op.f("ck_sync_resolutions_entity_type"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_sync_resolutions_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["undoes_id"],
            ["sync_resolutions.id"],
            name=op.f("fk_sync_resolutions_undoes_id_sync_resolutions"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["undone_by"],
            ["sync_resolutions.id"],
            name=op.f("fk_sync_resolutions_undone_by_sync_resolutions"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_sync_resolutions")),
    )
    op.create_index(
        "ix_sync_resolutions_user_id_created_at",
        "sync_resolutions",
        ["user_id", "created_at", "ordinal", "id"],
    )
    op.create_index(
        "ix_sync_resolutions_user_id_entity_id", "sync_resolutions", ["user_id", "entity_id"]
    )
    op.create_index("ix_sync_resolutions_created_at", "sync_resolutions", ["created_at"])
    op.create_index(
        "uq_sync_resolutions_op",
        "sync_resolutions",
        ["user_id", "op_key", "ordinal"],
        unique=True,
        postgresql_where=sa.text("op_key IS NOT NULL"),
    )
    op.create_index(
        "uq_sync_resolutions_undoes_id",
        "sync_resolutions",
        ["undoes_id"],
        unique=True,
        postgresql_where=sa.text("undoes_id IS NOT NULL"),
    )


def downgrade() -> None:
    # An older server does not know the entity type: it must not be announced any more.
    op.execute("DELETE FROM change_log WHERE entity_type = 'resolution'")
    op.drop_table("sync_resolutions")
