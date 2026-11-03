"""Device credentials for sync clients (SYNC-06, ADR-0059 D8, ADR-0065).

A *device* is one installed client (the desktop app, the Android app) that signs in with the
account's e-mail and password **once** and is then identified by a random bearer token. Only the
SHA-256 of the token is stored (the token is 256 random bits, so a fast hash is enough, the same
reasoning as the session tokens); the token itself is shown to the client exactly once and is
never logged. A revoked device keeps its row (so its token is answered ``token_revoked``, not
"unknown", and the resolution log can still name it) until the retention purge removes it.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, Uuid, func, text
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base

#: the platforms a client may declare; ``other`` is the escape hatch (a script, a future client)
PLATFORMS = ("windows", "linux", "macos", "android", "ios", "web", "other")


class Device(Base):
    __tablename__ = "devices"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    #: the label the user sees in Settings (the client proposes one, the user can rename it)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    platform: Mapped[str] = mapped_column(String(16), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    #: written by the server clock at most every few minutes (D11: never a device clock); ``NULL``
    #: until the first authenticated request after registration
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    #: SHA-256 (hex) of the current token
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    #: SHA-256 of the token before the last rotation, valid until ``prev_valid_until`` (a client
    #: that lost the rotation response keeps working); cleared as soon as the new token is used
    prev_token_hash: Mapped[str | None] = mapped_column(String(64))
    prev_valid_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint(
            "platform IN (" + ",".join(f"'{p}'" for p in PLATFORMS) + ")",
            name="platform",
        ),
        CheckConstraint("char_length(name) BETWEEN 1 AND 80", name="name_length"),
        Index("uq_devices_token_hash", "token_hash", unique=True),
        Index(
            "ix_devices_prev_token_hash",
            "prev_token_hash",
            postgresql_where=text("prev_token_hash IS NOT NULL"),
        ),
        Index("ix_devices_user_id_created_at", "user_id", "created_at"),
    )
