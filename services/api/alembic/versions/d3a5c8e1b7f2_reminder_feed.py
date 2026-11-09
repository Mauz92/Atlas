"""reminder feed entity and home time zone (M8-04a, ADR-0068)

Revision ID: d3a5c8e1b7f2
Revises: c9e4a7b2d6f1
Create Date: 2026-11-04

Additive and reversible.

* ``reminders``: ``state`` (``armed|cancelled``), ``revision`` (starts at 1), ``snoozed_until``,
  ``acknowledged_at``. ``state`` is derived for existing rows: ``cancelled`` when the reminder is
  cancelled or its task is deleted or no longer open (``inbox``/``next``/``in_progress``),
  otherwise ``armed``. ``status`` (the server's delivery bookkeeping) is untouched.
* ``users.home_time_zone`` (nullable): the zone for a task without its own ``time_zone``.
* **Backfill of the feed:** every existing reminder gets one ``change_log`` ``upsert`` row (entity
  type ``reminder``) at a fresh cursor of its user (``users.change_seq`` moves past them), so a
  device that asks for ``types=reminder`` learns of them. Clients that do not ask for the type, and
  browser callers without ``Atlas-Sync``, never see these rows. The statement is idempotent
  (``ON CONFLICT DO NOTHING`` on the feed key) and orders reminders by ``remind_at, id`` per user.

**Downgrade** removes the reminder feed rows and the four reminder columns and the zone column.
Snoozes and dismissals (device-visible outcomes) are lost; server delivery state, policies and
tasks are not touched. The cursor values already handed out stay used (the feed is monotonic).
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d3a5c8e1b7f2"
down_revision: str | None = "c9e4a7b2d6f1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_DELIVERABLE = "('inbox','next','in_progress')"


def upgrade() -> None:
    op.add_column(
        "reminders",
        sa.Column("state", sa.String(length=16), server_default="armed", nullable=False),
    )
    op.add_column(
        "reminders", sa.Column("revision", sa.Integer(), server_default="1", nullable=False)
    )
    op.add_column(
        "reminders", sa.Column("snoozed_until", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        "reminders", sa.Column("acknowledged_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.create_check_constraint(
        op.f("ck_reminders_state_known"), "reminders", "state IN ('armed','cancelled')"
    )
    op.create_check_constraint(op.f("ck_reminders_revision_positive"), "reminders", "revision >= 1")
    op.add_column("users", sa.Column("home_time_zone", sa.String(length=64), nullable=True))

    op.execute(
        f"""
        UPDATE reminders r SET state = 'cancelled'
        WHERE r.status = 'cancelled'
           OR NOT EXISTS (
                SELECT 1 FROM tasks t
                WHERE t.id = r.entity_id AND r.entity_type = 'task'
                  AND t.deleted_at IS NULL AND t.status IN {_DELIVERABLE}
           )
        """
    )
    # Feed backfill: one cursor per reminder, above the user's current cursor, in a stable order.
    op.execute(
        """
        WITH numbered AS (
            SELECT r.id, r.user_id,
                   u.change_seq + ROW_NUMBER() OVER (
                       PARTITION BY r.user_id ORDER BY r.remind_at, r.id
                   ) AS new_seq
            FROM reminders r JOIN users u ON u.id = r.user_id
            WHERE NOT EXISTS (
                SELECT 1 FROM change_log c
                WHERE c.user_id = r.user_id AND c.entity_type = 'reminder'
                  AND c.entity_id = r.id::text
            )
        ), ins AS (
            INSERT INTO change_log (user_id, entity_type, entity_id, operation, seq, changed_at)
            SELECT user_id, 'reminder', id::text, 'upsert', new_seq, now() FROM numbered
            ON CONFLICT DO NOTHING
            RETURNING user_id, seq
        )
        UPDATE users u SET change_seq = m.top
        FROM (SELECT user_id, MAX(seq) AS top FROM ins GROUP BY user_id) m
        WHERE u.id = m.user_id
        """
    )


def downgrade() -> None:
    op.execute("DELETE FROM change_log WHERE entity_type = 'reminder'")
    op.drop_column("users", "home_time_zone")
    op.drop_constraint(op.f("ck_reminders_revision_positive"), "reminders", type_="check")
    op.drop_constraint(op.f("ck_reminders_state_known"), "reminders", type_="check")
    op.drop_column("reminders", "acknowledged_at")
    op.drop_column("reminders", "snoozed_until")
    op.drop_column("reminders", "revision")
    op.drop_column("reminders", "state")
