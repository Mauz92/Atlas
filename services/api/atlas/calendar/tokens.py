"""Typed value objects and boundary validation for stored credentials (M5-01).

The token material an adapter needs is a :class:`TokenBundle`; the metadata an API/UI needs is a
:class:`CredentialMetadata`; together they are a :class:`StoredCredential`. The bundle's ``repr``
redacts token values, so an accidental log or error formatting cannot leak them (SECURITY.md T2).
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime

from ..models import CredentialProvider
from .errors import CredentialValidationError

_REDACTED = "[redacted]"

#: Longest accepted single token (JWT/opaque tokens are well under this).
MAX_TOKEN_LENGTH = 8192
#: Longest accepted ``token_type`` value.
MAX_TOKEN_TYPE_LENGTH = 64
#: Bound on the granted scope list and each scope string.
MAX_SCOPE_COUNT = 64
MAX_SCOPE_LENGTH = 256

_VALID_PROVIDERS = {provider.value for provider in CredentialProvider}


def _mask(value: str | None) -> str:
    """A log-safe stand-in for a secret: presence only, never the value."""
    return _REDACTED if value else "None"


@dataclass(frozen=True)
class TokenBundle:
    """The secret half of a stored credential: the OAuth tokens.

    ``refresh_token`` may be absent (some grants return only an access token); ``access_token`` may
    be absent for a credential that stored only a refresh token. At least one must be present when
    a credential is written (enforced by :func:`ensure_bundle_has_token`).
    """

    access_token: str | None = None
    refresh_token: str | None = None
    token_type: str = "Bearer"

    @property
    def has_refresh_token(self) -> bool:
        return bool(self.refresh_token)

    def to_payload(self) -> bytes:
        """Serialise the bundle for encryption. The bytes are never logged."""
        return json.dumps(
            {
                "access_token": self.access_token,
                "refresh_token": self.refresh_token,
                "token_type": self.token_type,
            },
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")

    @classmethod
    def from_payload(cls, payload: bytes) -> TokenBundle:
        """Reconstruct a bundle from decrypted plaintext (validates shape defensively)."""
        try:
            data = json.loads(payload)
        except (ValueError, UnicodeDecodeError) as exc:
            raise CredentialValidationError("stored credential payload is not valid JSON") from exc
        if not isinstance(data, dict):
            raise CredentialValidationError("stored credential payload is not an object")
        access = data.get("access_token")
        refresh = data.get("refresh_token")
        token_type = data.get("token_type", "Bearer")
        if access is not None and not isinstance(access, str):
            raise CredentialValidationError("stored access token is not a string")
        if refresh is not None and not isinstance(refresh, str):
            raise CredentialValidationError("stored refresh token is not a string")
        if not isinstance(token_type, str):
            raise CredentialValidationError("stored token type is not a string")
        return cls(access_token=access, refresh_token=refresh, token_type=token_type)

    def __repr__(self) -> str:
        return (
            f"TokenBundle(access_token={_mask(self.access_token)}, "
            f"refresh_token={_mask(self.refresh_token)}, token_type={self.token_type!r})"
        )

    __str__ = __repr__


@dataclass(frozen=True)
class CredentialMetadata:
    """The non-secret half of a stored credential — safe to return from an API or log."""

    provider: str
    key_id: str
    scopes: tuple[str, ...]
    access_expires_at: datetime | None
    refresh_expires_at: datetime | None
    has_refresh_token: bool
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class StoredCredential:
    """A credential read back from the store: metadata plus the decrypted token bundle."""

    metadata: CredentialMetadata
    tokens: TokenBundle


def normalise_provider(value: str) -> str:
    """Return the canonical provider value or raise :class:`CredentialValidationError`."""
    candidate = getattr(value, "value", value)
    if not isinstance(candidate, str) or candidate not in _VALID_PROVIDERS:
        raise CredentialValidationError(f"unknown provider {candidate!r}")
    return candidate


def clean_token(value: str | None, field: str) -> str | None:
    """Validate one token at the boundary; a blank value is treated as absent."""
    if value is None:
        return None
    if not isinstance(value, str):
        raise CredentialValidationError(f"{field} must be a string")
    if value.strip() == "":
        return None
    if len(value) > MAX_TOKEN_LENGTH:
        raise CredentialValidationError(f"{field} is too long")
    return value


def clean_token_type(value: str | None) -> str:
    if value is None or value.strip() == "":
        return "Bearer"
    if len(value) > MAX_TOKEN_TYPE_LENGTH:
        raise CredentialValidationError("token_type is too long")
    return value.strip()


def normalise_scopes(scopes: Iterable[str] | None) -> list[str]:
    """Trim, drop blanks, de-duplicate (order preserved) and bound a scope list."""
    if scopes is None:
        return []
    seen: list[str] = []
    for scope in scopes:
        if not isinstance(scope, str):
            raise CredentialValidationError("a scope must be a string")
        cleaned = scope.strip()
        if not cleaned:
            continue
        if len(cleaned) > MAX_SCOPE_LENGTH:
            raise CredentialValidationError("a scope is too long")
        if cleaned not in seen:
            seen.append(cleaned)
    if len(seen) > MAX_SCOPE_COUNT:
        raise CredentialValidationError("too many scopes")
    return seen


def normalise_expiry(value: datetime | None) -> datetime | None:
    """Return an aware UTC instant (a naive value is interpreted as UTC)."""
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value


def ensure_bundle_has_token(bundle: TokenBundle) -> None:
    """Reject a credential that would store nothing usable."""
    if not bundle.access_token and not bundle.refresh_token:
        raise CredentialValidationError("at least one of access_token or refresh_token is required")
