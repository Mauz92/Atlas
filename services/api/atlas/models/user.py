"""User accounts."""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import BigInteger, Boolean, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..db import Base
from .base import TimestampMixin

if TYPE_CHECKING:
    from .session import AuthSession


class User(Base, TimestampMixin):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False)
    display_name: Mapped[str] = mapped_column(String(120), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    #: Monotonic per-user cursor for the change feed (M7-01). Advanced by one for every recorded
    #: change, in the same transaction as the mutation, so a client can pull "everything after N"
    #: (``GET /api/changes?since=N``). Zero for a user that has never changed anything.
    change_seq: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=0, server_default="0"
    )
    #: Highest change-feed cursor that the retention purge has removed for this user (M7-02). Every
    #: change with ``seq <= change_purge_floor`` is no longer deliverable, so the feed answers
    #: ``resync_required`` for a client whose ``since`` is below it. Monotonic; zero until a purge
    #: runs. It never bounds the user's own entity rows — a soft-deleted entity stays a tombstone.
    change_purge_floor: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=0, server_default="0"
    )

    sessions: Mapped[list[AuthSession]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
