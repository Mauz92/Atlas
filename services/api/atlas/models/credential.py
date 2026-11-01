"""Per-user, per-provider OAuth credentials (M5-01).

This table is the security foundation for the calendar adapters (M5-03/M5-04). It stores, for one
user and one provider, the OAuth token material — **encrypted at rest** — plus the non-secret
metadata a sync needs: the granted scopes and the access/refresh expiry instants.

Design (``DECISIONS.md`` ADR-0027):

- **One credential per ``(user_id, provider)``**, enforced by a unique constraint. Reconnecting a
  provider replaces the existing credential; it never accumulates rows.
- **Ciphertext, not tokens.** ``ciphertext`` is an authenticated (AES-256-GCM) seal of a small JSON
  token bundle (access token, refresh token, token type). It is produced by
  :mod:`atlas.calendar.crypto`; Atlas writes no crypto itself (AGENTS.md §7.5).
- **Key outside the database.** The encryption key lives in configuration
  (``Settings.token_encryption_key``). ``key_id`` records *which* key version sealed this row, so a
  rotation can re-encrypt it; the key material itself is never stored here.
- **``scopes``/expiry are not secret** and are stored in clear, typed columns. ``scopes`` is a
  native ``text[]``; the instants are ``timestamptz``.
- The row is **deleted** when the account is disconnected (M5-05); a credential has no
  offline-client meaning, so there is no tombstone.

``user_id`` cascades on account deletion, so removing a user removes their stored credentials.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import (
    ARRAY,
    DateTime,
    ForeignKey,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base
from .base import TimestampMixin


class CredentialProvider(StrEnum):
    """The calendar providers Atlas stores credentials for (M5).

    Deliberately small: it grows only when an adapter is built. The value is what is persisted and
    what appears in URLs/API payloads.
    """

    GOOGLE = "google"
    MICROSOFT = "microsoft"


class ProviderCredential(Base, TimestampMixin):
    """An encrypted OAuth credential for one ``(user, provider)`` pair."""

    __tablename__ = "provider_credentials"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    provider: Mapped[str] = mapped_column(String(32), nullable=False)
    #: Identifier of the encryption key version that sealed ``ciphertext`` (rotation support).
    key_id: Mapped[str] = mapped_column(String(64), nullable=False)
    #: AES-256-GCM sealed JSON token bundle. Never returned by an API and never logged.
    ciphertext: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    #: Granted OAuth scopes (not secret). Defaults to an empty array.
    scopes: Mapped[list[str]] = mapped_column(
        ARRAY(Text), nullable=False, default=list, server_default=text("'{}'::text[]")
    )
    access_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    refresh_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # One credential per user+provider. The index this creates also serves the user-scoped lookups
    # (``user_id`` is the leading column), so no separate ``user_id`` index is needed.
    __table_args__ = (
        UniqueConstraint("user_id", "provider", name="uq_provider_credentials_user_provider"),
    )
