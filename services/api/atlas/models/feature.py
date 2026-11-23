"""Per-user switches for optional bundled features (TTRPG-01).

One row per ``(user, feature)``. A missing row means *disabled*: an optional feature is off for
every account, existing or new, until its owner switches it on in Settings. Disabling a feature
only flips ``enabled``; the feature's own data is never touched (it reappears on re-enable).
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


class UserFeature(Base):
    __tablename__ = "user_features"

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    feature: Mapped[str] = mapped_column(String(32), primary_key=True)
    enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
