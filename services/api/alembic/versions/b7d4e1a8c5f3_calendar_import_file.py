"""manual .ics file import: the file body on a calendar source (M5-12, ADR-0076 D4)

Revision ID: b7d4e1a8c5f3
Revises: a6c3e9d27b14
Create Date: 2026-11-13

Adds two nullable columns to ``calendar_sources``: ``imported_ics`` (the uploaded ``.ics`` bytes)
and ``imported_at``. A source with a body is an **imported calendar**: it has no feed URL, is
never fetched over the network, and is read by the same ICS parser as a feed. Re-importing
replaces the body and the sync layer tombstones events that are no longer in the file (the same
snapshot diff as a feed). Every existing row keeps working (both columns are NULL).

**Downgrade** drops the columns: imported calendars lose their stored file and can no longer be
re-read (their already projected events stay until the source is removed). Back up first if that
matters.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b7d4e1a8c5f3"
down_revision: str | None = "a6c3e9d27b14"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("calendar_sources", sa.Column("imported_ics", sa.LargeBinary(), nullable=True))
    op.add_column(
        "calendar_sources", sa.Column("imported_at", sa.DateTime(timezone=True), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("calendar_sources", "imported_at")
    op.drop_column("calendar_sources", "imported_ics")
