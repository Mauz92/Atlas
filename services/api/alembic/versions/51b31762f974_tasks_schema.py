"""tasks schema

Revision ID: 51b31762f974
Revises: 50c01dbff23c
Create Date: 2026-10-22
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "51b31762f974"
down_revision: str | None = "50c01dbff23c"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "tasks",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.String(length=512), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=16), server_default="inbox", nullable=False),
        sa.Column("priority", sa.String(length=16), server_default="none", nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=True),
        sa.Column("parent_task_id", sa.Uuid(), nullable=True),
        sa.Column("start_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("due_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("time_zone", sa.String(length=64), nullable=True),
        sa.Column("duration_minutes", sa.Integer(), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("recurrence_rule", sa.Text(), nullable=True),
        sa.Column("recurrence_parent_id", sa.Uuid(), nullable=True),
        sa.Column("reminder_policy_id", sa.Uuid(), nullable=True),
        sa.Column("external_provider", sa.String(length=32), nullable=True),
        sa.Column("external_id", sa.String(length=255), nullable=True),
        sa.Column("revision", sa.Integer(), server_default="1", nullable=False),
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
            ["user_id"], ["users.id"], name=op.f("fk_tasks_user_id_users"), ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["parent_task_id"],
            ["tasks.id"],
            name=op.f("fk_tasks_parent_task_id_tasks"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["recurrence_parent_id"],
            ["tasks.id"],
            name=op.f("fk_tasks_recurrence_parent_id_tasks"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_tasks")),
    )
    op.create_index(op.f("ix_tasks_due_at"), "tasks", ["due_at"], unique=False)
    op.create_index(op.f("ix_tasks_parent_task_id"), "tasks", ["parent_task_id"], unique=False)
    op.create_index(op.f("ix_tasks_priority"), "tasks", ["priority"], unique=False)
    op.create_index(op.f("ix_tasks_status"), "tasks", ["status"], unique=False)
    op.create_index(op.f("ix_tasks_user_id"), "tasks", ["user_id"], unique=False)
    op.create_table(
        "recurrence_series",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("rule", sa.Text(), nullable=False),
        sa.Column("dtstart", sa.DateTime(timezone=True), nullable=True),
        sa.Column("time_zone", sa.String(length=64), nullable=True),
        sa.Column("end_date", sa.Date(), nullable=True),
        sa.Column("count", sa.Integer(), nullable=True),
        sa.Column("recurrence_parent_id", sa.Uuid(), nullable=True),
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
            ["recurrence_parent_id"],
            ["tasks.id"],
            name=op.f("fk_recurrence_series_recurrence_parent_id_tasks"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_recurrence_series")),
    )
    op.create_index(
        op.f("ix_recurrence_series_recurrence_parent_id"),
        "recurrence_series",
        ["recurrence_parent_id"],
        unique=False,
    )
    op.create_table(
        "task_tags",
        sa.Column("task_id", sa.Uuid(), nullable=False),
        sa.Column("tag_id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(
            ["task_id"], ["tasks.id"], name=op.f("fk_task_tags_task_id_tasks"), ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["tag_id"], ["tags.id"], name=op.f("fk_task_tags_tag_id_tags"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("task_id", "tag_id", name=op.f("pk_task_tags")),
    )
    op.create_table(
        "task_links",
        sa.Column("task_id", sa.Uuid(), nullable=False),
        sa.Column("note_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["task_id"], ["tasks.id"], name=op.f("fk_task_links_task_id_tasks"), ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["note_id"], ["notes.id"], name=op.f("fk_task_links_note_id_notes"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("task_id", "note_id", name=op.f("pk_task_links")),
    )


def downgrade() -> None:
    op.drop_table("task_links")
    op.drop_table("task_tags")
    op.drop_index(op.f("ix_recurrence_series_recurrence_parent_id"), table_name="recurrence_series")
    op.drop_table("recurrence_series")
    op.drop_index(op.f("ix_tasks_user_id"), table_name="tasks")
    op.drop_index(op.f("ix_tasks_status"), table_name="tasks")
    op.drop_index(op.f("ix_tasks_priority"), table_name="tasks")
    op.drop_index(op.f("ix_tasks_parent_task_id"), table_name="tasks")
    op.drop_index(op.f("ix_tasks_due_at"), table_name="tasks")
    op.drop_table("tasks")
