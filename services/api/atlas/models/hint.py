"""Per-device sync-hint destination (M8-04e, ADR-0068 D6; SYNC_PROTOCOL.md 14.8).

At most one row per device. The endpoint is a **secret** (an ntfy topic URL is a bearer capability
to publish to, and possibly to read, that topic), so it is stored encrypted with the credential
cipher (AES-256-GCM, bound to the device id) and never returned by an API, logged or exported.
The row dies with its device (``ON DELETE CASCADE``) and is deleted explicitly when the device is
revoked, so no orphan secret outlives the credential that registered it.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, LargeBinary, String, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


class DeviceHint(Base):
    __tablename__ = "device_hints"

    device_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("devices.id", ondelete="CASCADE"), primary_key=True
    )
    kind: Mapped[str] = mapped_column(String(16), nullable=False, default="unifiedpush")
    endpoint_encrypted: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    key_id: Mapped[str] = mapped_column(String(32), nullable=False)
    #: the last 4 characters of the endpoint, for "ends in ....abcd" in Settings
    endpoint_tail: Mapped[str] = mapped_column(String(4), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    last_ok_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    #: a short class (``timeout``, ``unreachable``, ``rejected``, ``gone``...), never a message
    last_error_class: Mapped[str | None] = mapped_column(String(32))
    failures: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    #: set when the gateway answered 404/410: nothing is sent until the device registers again
    invalid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
