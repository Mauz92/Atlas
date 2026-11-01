"""Provider event projections and sync cursors (M5-06).

Provider events stay owned by their provider; PostgreSQL holds only a **projection** used to
display and reconcile them (``DATA_MODEL.md`` §2.4, ``ARCHITECTURE.md`` §5). This module defines two
tables:

- :class:`ExternalEvent` — one projected provider event, **unique per
  ``(user_id, provider, external_event_id)``**. A provider deletion is applied as a **tombstone**
  (``deleted_at``): the row is never hard-deleted on the sync path, so a short page can never be
  misread as "everything else is gone" (``DATA_MODEL.md`` §5).
- :class:`SyncCursor` — the durable incremental cursor for one ``(user_id, provider, calendar_id)``,
  **unique per that triple**. Its ``cursor_value`` is advanced **only in the same committed
  transaction** as the changes it covers (``CALENDAR_SYNC.md`` §4, AGENTS.md §10); the row also
  carries the last success/error state so sync status (M5-08) can surface it. ``cursor_value`` is
  nullable because the row may exist (recording an error) before the first successful baseline.

The columns are deliberately plain (``String``/``Text``/``Boolean``) rather than the neutral
``EventStatus``/``CursorType`` enums, so this model carries no dependency on
:mod:`atlas.calendar.types`; the sync service supplies the enum values. See ``DECISIONS.md``
ADR-0029.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base
from .base import TimestampMixin


class ExternalEvent(Base, TimestampMixin):
    """A read-only projection of one provider event (never authoritative for provider data)."""

    __tablename__ = "external_events"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    provider: Mapped[str] = mapped_column(String(32), nullable=False)
    #: The provider's event id (Google event id / Graph event id).
    external_event_id: Mapped[str] = mapped_column(String(512), nullable=False)
    #: The provider's calendar id the event belongs to (the neutral ``Event.calendar_id``).
    calendar_id: Mapped[str] = mapped_column(String(512), nullable=False)
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    start_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    end_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    #: IANA zone carried alongside the instants (all-day and wall-clock interpretation).
    time_zone: Mapped[str] = mapped_column(String(64), nullable=False)
    is_all_day: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    #: ``confirmed`` | ``tentative`` | ``cancelled`` (the neutral ``EventStatus``).
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    #: Provider version/concurrency token (Google ``etag``, Graph ``changeKey``), nullable.
    etag: Mapped[str | None] = mapped_column(Text, nullable=True)
    ical_uid: Mapped[str | None] = mapped_column(Text, nullable=True)
    recurrence_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    recurrence_rule: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: The provider's last-modified instant (the neutral ``Event.updated``).
    source_updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    #: When this projection was last written by a successful sync pass.
    last_synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    #: Tombstone: set when the provider no longer returns the event; never a hard delete.
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "provider",
            "external_event_id",
            name="uq_external_events_user_provider_external_event_id",
        ),
    )


class SyncCursor(Base, TimestampMixin):
    """The durable incremental cursor for one ``(user, provider, calendar)``.

    Besides the cursor it carries the last success/error state and, since M5-10, the durable
    ``sync_started_at`` running marker (set while a scan/reconcile run is underway). All of it is on
    this one row so sync status (M5-08) stays derived rather than stored twice (ADR-0030/ADR-0031).
    """

    __tablename__ = "sync_cursors"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    provider: Mapped[str] = mapped_column(String(32), nullable=False)
    calendar_id: Mapped[str] = mapped_column(String(512), nullable=False)
    #: ``sync_token`` | ``delta_link`` | ``history_id`` (the neutral ``CursorType``).
    cursor_type: Mapped[str] = mapped_column(String(16), nullable=False)
    #: The opaque provider cursor, advanced only with the changes it covers. Null until a first
    #: successful pass establishes a baseline.
    cursor_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: Durable running marker (M5-10): set in its own committed transaction when a scan/reconcile
    #: run begins for this calendar and cleared when it ends. Sync status derives an ``in_progress``
    #: state from it, bounded by a freshness window so a marker left by a crashed run cannot lie.
    sync_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_success_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    #: Diagnostic only: the last failure message (never event contents). See ADR-0029.
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_error_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "provider",
            "calendar_id",
            name="uq_sync_cursors_user_provider_calendar",
        ),
    )
