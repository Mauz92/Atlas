"""durable reminders: policies, scheduled reminders, delivery records (M8-01)

Revision ID: e5a91c3f7b64
Revises: c1a2b3d4e5f6
Create Date: 2026-10-27

Adds the durable reminder state described in ``DATA_MODEL.md`` §2.6 and ``PRODUCT_SPEC.md`` §5.6:

- ``reminder_policies``: a reusable per-user timing preference (``days_before`` days before the due
  calendar day, at ``at_time`` local wall-clock). ``tasks.reminder_policy_id`` gains a foreign key
  to it with ``ON DELETE SET NULL`` — deleting a preference never deletes a task.
- ``reminders``: the scheduled instance for one entity at one UTC instant, with the delivery state
  (``scheduled``/``sent``/``cancelled``/``failed``) and attempt counters.
  ``uq_reminders_entity_type_entity_id`` keeps at most one reminder per entity, so a reschedule
  edits in place. ``ix_reminders_due`` serves the recurring scan's "which reminders are due" query.
- ``reminder_deliveries``: the delivery record. ``uq_reminder_deliveries_reminder_id`` allows at
  most one row per reminder, which is what makes delivery idempotent across retries (AGENTS.md §9).

Only new tables and one new foreign key are added; no existing data is rewritten, so the migration
is backward compatible. Both directions are reversible.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e5a91c3f7b64"
down_revision: str | None = "c1a2b3d4e5f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "reminder_policies",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column("days_before", sa.Integer(), server_default="0", nullable=False),
        sa.Column("at_time", sa.Time(), server_default="09:00:00", nullable=False),
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
            name=op.f("fk_reminder_policies_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_reminder_policies")),
        sa.UniqueConstraint("user_id", "name", name="uq_reminder_policies_user_id_name"),
    )
    op.create_index(
        op.f("ix_reminder_policies_user_id"), "reminder_policies", ["user_id"], unique=False
    )
    op.create_foreign_key(
        op.f("fk_tasks_reminder_policy_id_reminder_policies"),
        "tasks",
        "reminder_policies",
        ["reminder_policy_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_table(
        "reminders",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("policy_id", sa.Uuid(), nullable=True),
        sa.Column("entity_type", sa.String(length=16), server_default="task", nullable=False),
        sa.Column("entity_id", sa.Uuid(), nullable=False),
        sa.Column("remind_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", sa.String(length=16), server_default="scheduled", nullable=False),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("last_attempt_at", sa.DateTime(timezone=True), nullable=True),
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
            name=op.f("fk_reminders_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["policy_id"],
            ["reminder_policies.id"],
            name=op.f("fk_reminders_policy_id_reminder_policies"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_reminders")),
        sa.UniqueConstraint("entity_type", "entity_id", name="uq_reminders_entity_type_entity_id"),
    )
    op.create_index(op.f("ix_reminders_user_id"), "reminders", ["user_id"], unique=False)
    op.create_index("ix_reminders_due", "reminders", ["status", "remind_at"], unique=False)
    op.create_table(
        "reminder_deliveries",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("reminder_id", sa.Uuid(), nullable=False),
        sa.Column("channel", sa.String(length=32), nullable=False),
        sa.Column(
            "delivered_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("detail", sa.Text(), nullable=True),
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
            ["reminder_id"],
            ["reminders.id"],
            name=op.f("fk_reminder_deliveries_reminder_id_reminders"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_reminder_deliveries")),
        sa.UniqueConstraint("reminder_id", name=op.f("uq_reminder_deliveries_reminder_id")),
    )


def downgrade() -> None:
    op.drop_table("reminder_deliveries")
    op.drop_index("ix_reminders_due", table_name="reminders")
    op.drop_index(op.f("ix_reminders_user_id"), table_name="reminders")
    op.drop_table("reminders")
    op.drop_constraint(
        op.f("fk_tasks_reminder_policy_id_reminder_policies"), "tasks", type_="foreignkey"
    )
    op.drop_index(op.f("ix_reminder_policies_user_id"), table_name="reminder_policies")
    op.drop_table("reminder_policies")
