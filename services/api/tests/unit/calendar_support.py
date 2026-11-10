"""Helpers shared by the calendar unit tests."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from atlas.calendar.tokens import CredentialMetadata, StoredCredential, TokenBundle


def stored_credential(
    provider: str = "google",
    *,
    access: str | None = "fake-access-initial",
    refresh: str | None = "fake-refresh-initial",
    expires_in: timedelta | None = timedelta(hours=1),
) -> StoredCredential:
    now = datetime.now(UTC)
    return StoredCredential(
        metadata=CredentialMetadata(
            provider=provider,
            key_id="v1",
            scopes=(),
            access_expires_at=now + expires_in if expires_in is not None else None,
            refresh_expires_at=None,
            has_refresh_token=bool(refresh),
            created_at=now,
            updated_at=now,
        ),
        tokens=TokenBundle(access_token=access, refresh_token=refresh),
    )
