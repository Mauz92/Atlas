"""Notification destination registry (M8-03).

The backend must know **where** to deliver a reminder/notification before it can push one
(``PRODUCT_SPEC.md`` §5.6). ``NotificationDevice`` is that registry: one row per **destination** a
user has registered, keyed by ``(user_id, channel, endpoint)``.

- ``channel`` is ``web`` (a Web Push subscription), ``android`` or ``ios`` (a native push token).
- ``endpoint`` holds the destination identifier: a Web Push endpoint URL for ``web``, or the push
  token for ``android``/``ios``. It is the value the unique key is built on, so re-registering the
  same destination **upserts** rather than duplicating (``AGENTS.md`` §9).
- ``p256dh``/``auth`` are the Web Push subscription's client keys (web only). They are stored only
  to send; the API never returns them and they are never logged (``AGENTS.md`` §11).
- ``platform`` is an optional user-agent / platform hint for display.
- ``last_seen_at`` is refreshed on every (re-)register; ``disabled_at`` marks a destination the
  delivery path reported invalid/expired (e.g. a Web Push ``404``/``410``), so it is **not retried**
  (M8-03 invalidation). A re-register of the same destination revives it.

``user_id`` cascades on account deletion, so removing a user removes their registered devices.
``DATA_MODEL.md`` §2.5 documents the entity; ``DECISIONS.md`` ADR-0038 records the design.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base
from .base import TimestampMixin


class PushChannel(StrEnum):
    """The delivery channels a destination can belong to (M8-03).

    Deliberately small: ``web`` is the PWA/Web Push subscription (M8-02); ``android``/``ios`` are
    native push tokens (M8-04). The value is what is persisted and what appears in API payloads.
    """

    WEB = "web"
    ANDROID = "android"
    IOS = "ios"


class NotificationDevice(Base, TimestampMixin):
    """One push destination registered by a user (M8-03)."""

    __tablename__ = "notification_devices"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    channel: Mapped[str] = mapped_column(String(16), nullable=False)
    #: The destination identifier: a Web Push endpoint URL (``web``) or a native push token
    #: (``android``/``ios``). The unique key below makes a re-register an upsert, never a duplicate.
    endpoint: Mapped[str] = mapped_column(String(1024), nullable=False)
    #: Web Push subscription client public key (web only; never returned or logged).
    p256dh: Mapped[str | None] = mapped_column(String(256), nullable=True)
    #: Web Push subscription auth secret (web only; never returned or logged).
    auth: Mapped[str | None] = mapped_column(String(256), nullable=True)
    #: Optional user-agent / platform hint, for display only.
    platform: Mapped[str | None] = mapped_column(String(128), nullable=True)
    #: Refreshed on every (re-)register, so the caller can see a destination is still active.
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    #: When the delivery path reported this destination invalid/expired (M8-03 invalidation). A
    #: non-null value means later deliveries do **not** target the row; a re-register clears it.
    disabled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # One row per (user, channel, endpoint): re-registering a destination updates it in place rather
    # than accumulating duplicates (AGENTS.md §9). The index this creates also serves the
    # user-scoped lookups (``user_id`` is the leading column), so no separate user index is needed.
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "channel",
            "endpoint",
            name="uq_notification_devices_user_channel_endpoint",
        ),
    )


__all__ = ["NotificationDevice", "PushChannel"]
