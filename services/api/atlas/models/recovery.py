"""The account recovery code (AUTH-01, ADR-0067).

One row per user, at most. Only a salted HMAC-SHA-256 of the code is stored; the code itself (150
random bits) exists in clear exactly once, in the response that issues it. ``failed_attempts``
counts wrong tries since the last success and is diagnostic only: it never changes an answer
(the throttle that does is in memory and treats unknown accounts identically).
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, String, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


class RecoveryCode(Base):
    __tablename__ = "recovery_codes"

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    #: hex of 16 random bytes; the HMAC key, so two users with equal codes would still differ
    code_salt: Mapped[str] = mapped_column(String(32), nullable=False)
    #: hex HMAC-SHA-256 of the normalised code
    code_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    #: the last time the code was used to reset the password (``NULL`` = never)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    failed_attempts: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )

    __table_args__ = (CheckConstraint("failed_attempts >= 0", name="failed_attempts_nonneg"),)
