"""Typed service for the encrypted OAuth credential store (M5-01).

Responsibilities, and the boundaries they live behind:

- **upsert / read / refresh / delete** one credential per ``(user, provider)``;
- encryption via :mod:`atlas.calendar.crypto` (never inline crypto here);
- **strict user scoping** — every query filters on the caller's ``user_id``, so another user's
  credential is indistinguishable from a missing one (:class:`CredentialNotFoundError`);
- boundary validation (provider, tokens, scopes) with :class:`CredentialValidationError`;
- no token material in error messages (see :mod:`atlas.calendar.errors`).

The service never contacts a provider: the OAuth exchange itself belongs to the calendar adapters
(M5-03/M5-04). ``refresh`` simply records the result of a token refresh the caller has already
performed. The API only ever exposes :class:`CredentialMetadata`; decrypted tokens are returned
solely to in-process callers through :meth:`read`.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Sequence
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import ProviderCredential
from .crypto import DecryptionError, TokenCipher, get_token_cipher
from .errors import CredentialDecryptionError, CredentialNotFoundError, CredentialValidationError
from .tokens import (
    CredentialMetadata,
    StoredCredential,
    TokenBundle,
    clean_token,
    clean_token_type,
    ensure_bundle_has_token,
    normalise_expiry,
    normalise_provider,
    normalise_scopes,
)


class ProviderCredentialsService:
    """Read/write access to the caller's encrypted provider credentials."""

    def __init__(
        self,
        session: AsyncSession,
        user_id: uuid.UUID,
        *,
        cipher: TokenCipher | None = None,
    ) -> None:
        self.session = session
        self.user_id = user_id
        self._cipher = cipher if cipher is not None else get_token_cipher()

    def _aad(self, provider: str) -> bytes:
        """Associated data binding a ciphertext to its ``(user, provider)`` row.

        The AEAD authenticates this value, so a ciphertext copied onto a different user's (or
        provider's) row fails to decrypt rather than silently substituting a credential.
        """
        return f"provider-credentials:{self.user_id}:{provider}".encode()

    async def upsert(
        self,
        provider: str,
        *,
        tokens: TokenBundle,
        scopes: Iterable[str] | None = None,
        access_expires_at: datetime | None = None,
        refresh_expires_at: datetime | None = None,
    ) -> CredentialMetadata:
        """Create or replace the caller's credential for ``provider`` (one row per pair).

        The whole token bundle is re-sealed with the active key, so an upsert after a rotation
        naturally re-encrypts the row. Returns the non-secret metadata.
        """
        provider = normalise_provider(provider)
        bundle = TokenBundle(
            access_token=clean_token(tokens.access_token, "access_token"),
            refresh_token=clean_token(tokens.refresh_token, "refresh_token"),
            token_type=clean_token_type(tokens.token_type),
        )
        ensure_bundle_has_token(bundle)
        clean_scopes = normalise_scopes(scopes)
        access_expiry = normalise_expiry(access_expires_at)
        refresh_expiry = normalise_expiry(refresh_expires_at)

        key_id = self._cipher.active_key_id
        ciphertext = self._cipher.encrypt(bundle.to_payload(), aad=self._aad(provider))
        values = {
            "id": uuid.uuid4(),
            "user_id": self.user_id,
            "provider": provider,
            "key_id": key_id,
            "ciphertext": ciphertext,
            "scopes": clean_scopes,
            "access_expires_at": access_expiry,
            "refresh_expires_at": refresh_expiry,
        }
        statement = (
            pg_insert(ProviderCredential)
            .values(**values)
            .on_conflict_do_update(
                constraint="uq_provider_credentials_user_provider",
                set_={
                    "key_id": key_id,
                    "ciphertext": ciphertext,
                    "scopes": clean_scopes,
                    "access_expires_at": access_expiry,
                    "refresh_expires_at": refresh_expiry,
                    "updated_at": func.now(),
                },
            )
        )
        await self.session.execute(statement)
        row = await self._require_row(provider)
        return self._metadata(row, bundle)

    async def read(self, provider: str) -> StoredCredential:
        """Decrypt and return the caller's credential (metadata **and** tokens).

        This is the in-process read path for the calendar adapters. It must never be serialised
        directly into an API response or a log.
        """
        row = await self._require_row(provider)
        bundle = self._decrypt(row)
        return StoredCredential(metadata=self._metadata(row, bundle), tokens=bundle)

    async def describe(self, provider: str) -> CredentialMetadata:
        """The non-secret metadata for one provider (safe to return from an API)."""
        return (await self.read(provider)).metadata

    async def list_metadata(self) -> list[CredentialMetadata]:
        """The caller's stored credentials, metadata only, ordered by provider."""
        rows = await self.session.scalars(
            select(ProviderCredential)
            .where(ProviderCredential.user_id == self.user_id)
            .order_by(ProviderCredential.provider)
        )
        return [self._metadata(row, self._decrypt(row)) for row in rows]

    async def refresh(
        self,
        provider: str,
        *,
        access_token: str,
        refresh_token: str | None = None,
        scopes: Sequence[str] | None = None,
        access_expires_at: datetime | None = None,
        refresh_expires_at: datetime | None = None,
    ) -> CredentialMetadata:
        """Record the result of a token refresh for an existing credential.

        The new ``access_token`` is required. ``refresh_token`` is replaced only when one is
        supplied (providers often do not re-issue it), and ``scopes``/expiries are replaced only
        when given. The stored bundle is re-sealed with the active key. Raises
        :class:`~atlas.calendar.errors.CredentialNotFoundError` when no credential exists.
        """
        row = await self._require_row(provider)
        current = self._decrypt(row)
        new_access = clean_token(access_token, "access_token")
        if new_access is None:
            raise CredentialValidationError("access_token is required")
        new_refresh = clean_token(refresh_token, "refresh_token")
        bundle = TokenBundle(
            access_token=new_access,
            refresh_token=new_refresh if new_refresh is not None else current.refresh_token,
            token_type=current.token_type,
        )
        ensure_bundle_has_token(bundle)

        row.key_id = self._cipher.active_key_id
        row.ciphertext = self._cipher.encrypt(bundle.to_payload(), aad=self._aad(row.provider))
        if scopes is not None:
            row.scopes = normalise_scopes(scopes)
        if access_expires_at is not None:
            row.access_expires_at = normalise_expiry(access_expires_at)
        if refresh_expires_at is not None:
            row.refresh_expires_at = normalise_expiry(refresh_expires_at)
        await self.session.flush()
        await self.session.refresh(row)
        return self._metadata(row, bundle)

    async def delete(self, provider: str) -> None:
        """Remove the caller's credential for ``provider``.

        A hard delete: a credential has no offline-client meaning and retaining ciphertext adds no
        value. Provider-side revocation on disconnect is the account flow's concern (M5-05).
        """
        row = await self._require_row(provider)
        await self.session.delete(row)
        await self.session.flush()

    async def _require_row(self, provider: str) -> ProviderCredential:
        provider = normalise_provider(provider)
        row = await self.session.scalar(
            select(ProviderCredential)
            .where(
                ProviderCredential.user_id == self.user_id,
                ProviderCredential.provider == provider,
            )
            .execution_options(populate_existing=True)
        )
        if row is None:
            raise CredentialNotFoundError(provider)
        return row

    def _decrypt(self, row: ProviderCredential) -> TokenBundle:
        try:
            payload = self._cipher.decrypt(
                row.ciphertext, key_id=row.key_id, aad=self._aad(row.provider)
            )
        except DecryptionError as exc:
            raise CredentialDecryptionError(row.provider) from exc
        return TokenBundle.from_payload(payload)

    def _metadata(self, row: ProviderCredential, bundle: TokenBundle) -> CredentialMetadata:
        return CredentialMetadata(
            provider=row.provider,
            key_id=row.key_id,
            scopes=tuple(row.scopes),
            access_expires_at=row.access_expires_at,
            refresh_expires_at=row.refresh_expires_at,
            has_refresh_token=bundle.has_refresh_token,
            created_at=row.created_at,
            updated_at=row.updated_at,
        )
