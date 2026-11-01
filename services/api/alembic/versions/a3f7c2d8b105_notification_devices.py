"""notification destination registry (M8-03)

Revision ID: a3f7c2d8b105
Revises: e5a91c3f7b64
Create Date: 2026-10-27

Adds ``notification_devices`` (M8-03): one row per push destination a user has registered, keyed by
``(user_id, channel, endpoint)``.

- ``channel`` is ``web`` (a Web Push subscription), ``android`` or ``ios`` (a native push token).
- ``endpoint`` is the destination identifier — a Web Push endpoint URL, or the push token. The
  unique constraint ``uq_notification_devices_user_channel_endpoint`` makes re-registering the same
  destination an upsert rather than a duplicate (``AGENTS.md`` §9).
- ``p256dh``/``auth`` are the Web Push subscription client keys (web only); they are stored only to
  send and are never returned by an API or logged.
- ``last_seen_at`` is refreshed on every (re-)register; ``disabled_at`` marks a destination the
  delivery path reported invalid/expired, so it is not retried (M8-03 invalidation).

Only a new table is added; no existing table or data is touched, so the migration is backward
compatible. Both directions are reversible. See ``DECISIONS.md`` ADR-0038 and ``DATA_MODEL.md``.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a3f7c2d8b105"
down_revision: str | None = "e5a91c3f7b64"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "notification_devices",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("channel", sa.String(length=16), nullable=False),
        sa.Column("endpoint", sa.String(length=1024), nullable=False),
        sa.Column("p256dh", sa.String(length=256), nullable=True),
        sa.Column("auth", sa.String(length=256), nullable=True),
        sa.Column("platform", sa.String(length=128), nullable=True),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("disabled_at", sa.DateTime(timezone=True), nullable=True),
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
            name=op.f("fk_notification_devices_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_notification_devices")),
        sa.UniqueConstraint(
            "user_id",
            "channel",
            "endpoint",
            name="uq_notification_devices_user_channel_endpoint",
        ),
    )


def downgrade() -> None:
    op.drop_table("notification_devices")
