"""Reminder tables (M8-01).

The backend owns scheduling and durable reminder state (``PRODUCT_SPEC.md`` §5.6, ``DATA_MODEL.md``
§2.6). Three tables back that:

- ``ReminderPolicy`` — a reusable, per-user timing preference ("remind me ``days_before`` days
  before the due date at ``at_time`` local wall-clock time"). ``tasks.reminder_policy_id``
  references it with ``ON DELETE SET NULL``; a task with no policy has no reminder.
- ``Reminder`` — the durable *scheduled instance* for one entity at one UTC instant
  (``remind_at``). It carries the delivery state (``scheduled`` → ``sent``/``cancelled``/``failed``)
  and the attempt counters. It is materialised from the entity's due date and policy and is the
  row a durable delivery job is keyed on, so the schedule survives a worker restart (ADR-0005).
- ``ReminderDelivery`` — the **delivery record**: at most one row per reminder
  (``UniqueConstraint("reminder_id")``), written in the same transaction that marks the reminder
  ``sent``. Its uniqueness is what guarantees a fired reminder is never delivered twice, even if a
  delivery job is retried after a worker restart (``AGENTS.md`` §9).

Only ``task`` entities are scheduled today; ``entity_type`` already allows ``event`` so calendar
reminders (M5/M6) can reuse the same store without a schema change. All instants are stored UTC;
the wall-clock interpretation of a reminder comes from ``atlas/tasks/timezones.py`` (ADR-0014).
"""

from __future__ import annotations

import uuid
from datetime import datetime, time
from enum import StrEnum

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    Time,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base
from .base import TimestampMixin


class ReminderStatus(StrEnum):
    SCHEDULED = "scheduled"
    SENT = "sent"
    CANCELLED = "cancelled"
    FAILED = "failed"


class ReminderEntityType(StrEnum):
    TASK = "task"
    EVENT = "event"


class ReminderPolicy(Base, TimestampMixin):
    """A per-user reminder timing preference referenced by ``tasks.reminder_policy_id``."""

    __tablename__ = "reminder_policies"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    #: Whole days before the entity's due calendar day.
    days_before: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    #: Local wall-clock time of day the reminder fires, interpreted in the entity's IANA zone.
    at_time: Mapped[time] = mapped_column(
        Time, nullable=False, default=time(9, 0), server_default="09:00:00"
    )
    #: M8-05: the user's default timing, applied to the user's tasks that carry no per-task
    #: override. At most one policy per user may be the default (see the partial unique index).
    is_default: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )

    __table_args__ = (
        UniqueConstraint("user_id", "name", name="uq_reminder_policies_user_id_name"),
        # At most one default policy per user (M8-05). A partial unique index keeps the invariant
        # in the database without constraining the user's other, named policies.
        Index(
            "uq_reminder_policies_default",
            "user_id",
            unique=True,
            postgresql_where=text("is_default"),
        ),
    )


class Reminder(Base, TimestampMixin):
    """The durable scheduled reminder for one entity."""

    __tablename__ = "reminders"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    policy_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("reminder_policies.id", ondelete="SET NULL"), nullable=True
    )
    entity_type: Mapped[str] = mapped_column(
        String(16), nullable=False, default=ReminderEntityType.TASK.value, server_default="task"
    )
    entity_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    remind_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    status: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
        default=ReminderStatus.SCHEDULED.value,
        server_default=ReminderStatus.SCHEDULED.value,
    )
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    last_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        # One reminder per entity: re-scheduling edits the row in place rather than piling up
        # duplicates (AGENTS.md §9 — a retry/reschedule must not create duplicate reminders).
        UniqueConstraint("entity_type", "entity_id", name="uq_reminders_entity_type_entity_id"),
        # Serves the recurring scan's "which reminders are due" query.
        Index("ix_reminders_due", "status", "remind_at"),
    )


class ReminderDelivery(Base, TimestampMixin):
    """The single delivery record for a reminder (at-most-once delivery)."""

    __tablename__ = "reminder_deliveries"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    reminder_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("reminders.id", ondelete="CASCADE"), nullable=False
    )
    channel: Mapped[str] = mapped_column(String(32), nullable=False)
    delivered_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)

    __table_args__ = (UniqueConstraint("reminder_id"),)
