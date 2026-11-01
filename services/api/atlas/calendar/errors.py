"""Domain errors for the calendar subsystem.

**Credential-store errors (M5-01).** None of these carry token material or key material: messages
name the provider at most, so an error raised (and potentially logged or translated into an HTTP
response) can never leak a secret.

**Adapter contract + provider-error taxonomy (M5-02).** Adapters translate whatever a provider does
(a thrown SDK exception, a 401/403/429/5xx status, a link/parse failure) into one of the
:class:`ProviderError` subclasses below. The sync layer then decides how to react *without knowing
which provider it is talking to*: retry with bounded exponential backoff + jitter, honour a
``Retry-After``, require re-authentication, or treat the failure as terminal and surface it to sync
status (CALENDAR_SYNC §3, ARCHITECTURE §6.3, AGENTS.md §10). The mapping is expressed as a
:class:`RetryDisposition` so it can be asserted and reused.
"""

from __future__ import annotations

from collections.abc import Iterable
from enum import StrEnum
from typing import ClassVar

from ..jobs.queue import backoff_delay


class CredentialError(Exception):
    """Base class for credential-store errors."""


class CredentialValidationError(CredentialError, ValueError):
    """A value at the service boundary was rejected (unknown provider, empty token, bad scopes)."""


class CredentialNotFoundError(CredentialError, LookupError):
    """No credential exists for the calling user and the requested provider.

    Another user's credential is indistinguishable from a missing one, so callers cannot probe for
    its existence.
    """


class CredentialDecryptionError(CredentialError):
    """A stored credential could not be decrypted (tampering, wrong key or corruption)."""

    def __init__(self, provider: str) -> None:
        super().__init__(f"stored credential for provider {provider!r} could not be decrypted")
        self.provider = provider


# --- Adapter contract + provider-error taxonomy (M5-02) --------------------


class AdapterError(Exception):
    """Base class for adapter contract/registry errors (a misconfiguration, not a provider call)."""


class UnknownProviderError(AdapterError, LookupError):
    """No adapter is registered for the requested provider name.

    Raised by the registry/factory so a typo or an unbuilt provider fails clearly at the seam
    instead of producing a confusing downstream error.
    """

    def __init__(self, provider: str, *, known: Iterable[str] = ()) -> None:
        self.provider = provider
        self.known: tuple[str, ...] = tuple(sorted(known))
        known_text = ", ".join(self.known) if self.known else "none"
        super().__init__(
            f"no calendar adapter is registered for provider {provider!r} "
            f"(known providers: {known_text})"
        )


class RetryDisposition(StrEnum):
    """How the sync layer should react to a provider failure.

    This is the documented retry classification (CALENDAR_SYNC §3): ``RETRY_BACKOFF`` for
    transient faults, ``RETRY_AFTER`` for throttling, ``REAUTH`` for an expired/revoked token and
    ``PERMANENT`` for errors that will not fix themselves.
    """

    RETRY_BACKOFF = "retry_backoff"
    RETRY_AFTER = "retry_after"
    REAUTH = "reauth"
    PERMANENT = "permanent"


class ProviderError(Exception):
    """Base class for a failure reported while talking to a calendar provider.

    An adapter raises one of the subclasses; nothing about the concrete provider (status code shape,
    exception class, ``syncToken``/``deltaLink``) is exposed to the caller.
    """

    #: The retry classification for this error class.
    disposition: ClassVar[RetryDisposition] = RetryDisposition.PERMANENT

    def __init__(self, message: str, *, provider: str | None = None) -> None:
        super().__init__(message)
        self.provider = provider

    @property
    def retryable(self) -> bool:
        """Whether the sync layer should retry after a delay (as opposed to re-auth or give up)."""
        return self.disposition in (
            RetryDisposition.RETRY_BACKOFF,
            RetryDisposition.RETRY_AFTER,
        )


class AuthExpiredError(ProviderError):
    """The access token is expired/revoked and the account must be re-authenticated.

    Not retried automatically: the user (or the token-refresh flow) must obtain fresh credentials
    first (CALENDAR_SYNC §3 Stage B, AGENTS.md §10 "token expiry and revocation handling").
    """

    disposition: ClassVar[RetryDisposition] = RetryDisposition.REAUTH


class RateLimitedError(ProviderError):
    """The provider throttled the request; honour ``retry_after`` before retrying.

    ``retry_after`` is the provider-advertised delay in seconds when it supplied one
    (``Retry-After`` / Graph's ``Retry-After``) and ``None`` otherwise, in which case the caller
    falls back to the shared bounded exponential backoff.
    """

    disposition: ClassVar[RetryDisposition] = RetryDisposition.RETRY_AFTER

    def __init__(
        self,
        message: str = "provider rate limit reached",
        *,
        retry_after: float | None = None,
        provider: str | None = None,
    ) -> None:
        super().__init__(message, provider=provider)
        self.retry_after = retry_after


class TransientProviderError(ProviderError):
    """A temporary failure (network blip, 5xx, timeout) that should be retried with backoff."""

    disposition: ClassVar[RetryDisposition] = RetryDisposition.RETRY_BACKOFF


class PermanentProviderError(ProviderError):
    """A terminal failure (bad payload, missing calendar, revoked resource) — do not retry."""

    disposition: ClassVar[RetryDisposition] = RetryDisposition.PERMANENT


def retry_delay_for(error: ProviderError, attempt: int) -> float | None:
    """Seconds to wait before retrying ``attempt`` (1-based), or ``None`` if it must not be retried.

    Concretely: ``RETRY_AFTER`` honours the provider's ``Retry-After`` when it supplied one;
    ``RETRY_BACKOFF`` uses the shared bounded exponential backoff with jitter
    (:func:`atlas.jobs.queue.backoff_delay`); ``REAUTH`` and ``PERMANENT`` are not retried.
    """
    if error.disposition in (RetryDisposition.REAUTH, RetryDisposition.PERMANENT):
        return None
    if isinstance(error, RateLimitedError) and error.retry_after is not None:
        return max(error.retry_after, 0.0)
    return backoff_delay(attempt)
