"""reminder policies: per-user default timing (M8-05)

Revision ID: f1b2c3d4e5a6
Revises: a3f7c2d8b105
Create Date: 2026-10-27

Adds ``reminder_policies.is_default`` (M8-05): a user's reminder timing may be marked as their
**default**, applied to the user's tasks that carry no per-task override. A partial unique index
(``uq_reminder_policies_default``) guarantees at most one default policy per user without
constraining the user's other, named policies.

The column is added with a ``false`` server default, so every existing policy stays a plain, named
policy and no existing reminder changes behaviour. It is a single added column plus an index and
rewrites no data, so the migration is backward compatible; both directions are reversible. See
``DECISIONS.md`` ADR-0040 and ``DATA_MODEL.md`` §2.6.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f1b2c3d4e5a6"
down_revision: str | None = "a3f7c2d8b105"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "reminder_policies",
        sa.Column("is_default", sa.Boolean(), server_default="false", nullable=False),
    )
    op.create_index(
        "uq_reminder_policies_default",
        "reminder_policies",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("is_default"),
    )


def downgrade() -> None:
    op.drop_index("uq_reminder_policies_default", table_name="reminder_policies")
    op.drop_column("reminder_policies", "is_default")
