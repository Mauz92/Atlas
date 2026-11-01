"""Provider-error taxonomy and its retry classification (M5-02).

The point of the taxonomy is that the sync layer can decide how to react *without* knowing which
provider raised the error (CALENDAR_SYNC §3, ARCHITECTURE §6.3). These tests pin the classification
and the delay helper.
"""

from __future__ import annotations

import pytest

from atlas.calendar import (
    AdapterError,
    AuthExpiredError,
    PermanentProviderError,
    ProviderError,
    RateLimitedError,
    RetryDisposition,
    TransientProviderError,
    UnknownProviderError,
    retry_delay_for,
)

TRANSIENT = TransientProviderError("temporary glitch", provider="google")
AUTH = AuthExpiredError("access token expired", provider="google")
PERMANENT = PermanentProviderError("calendar was deleted", provider="google")


def test_every_error_class_maps_to_one_of_the_documented_retry_classes() -> None:
    assert TransientProviderError.disposition is RetryDisposition.RETRY_BACKOFF
    assert RateLimitedError.disposition is RetryDisposition.RETRY_AFTER
    assert AuthExpiredError.disposition is RetryDisposition.REAUTH
    assert PermanentProviderError.disposition is RetryDisposition.PERMANENT
    assert {
        TransientProviderError.disposition,
        RateLimitedError.disposition,
        AuthExpiredError.disposition,
        PermanentProviderError.disposition,
    } == set(RetryDisposition)


def test_retryable_matches_the_disposition() -> None:
    assert TRANSIENT.retryable is True
    assert RateLimitedError().retryable is True
    assert AUTH.retryable is False
    assert PERMANENT.retryable is False


def test_transient_errors_back_off_and_grow_with_attempts() -> None:
    early = [retry_delay_for(TRANSIENT, 1) for _ in range(50)]
    later = [retry_delay_for(TRANSIENT, 10) for _ in range(50)]
    assert all(delay is not None and delay > 0 for delay in early + later)
    assert max(delay for delay in early if delay is not None) < min(
        delay for delay in later if delay is not None
    )


def test_rate_limited_honours_the_provider_retry_after() -> None:
    assert retry_delay_for(RateLimitedError(retry_after=42.0), 1) == 42.0


def test_rate_limited_without_retry_after_falls_back_to_backoff() -> None:
    delay = retry_delay_for(RateLimitedError(), 1)
    assert delay is not None
    assert 0 < delay <= 5.0


def test_auth_expired_and_permanent_errors_are_never_retried() -> None:
    assert retry_delay_for(AUTH, 1) is None
    assert retry_delay_for(PERMANENT, 1) is None


def test_provider_errors_carry_optional_provider_context() -> None:
    assert TRANSIENT.provider == "google"
    assert TransientProviderError("boom").provider is None


def test_auth_expired_error_is_distinct_from_permanent() -> None:
    assert isinstance(AUTH, ProviderError)
    assert not isinstance(AUTH, PermanentProviderError)
    assert len({type(AUTH), type(PERMANENT)}) == 2


def test_unknown_provider_error_is_a_lookup_error_naming_known_providers() -> None:
    error = UnknownProviderError("bogus", known=["microsoft", "google"])
    assert isinstance(error, AdapterError)
    assert isinstance(error, LookupError)
    assert error.provider == "bogus"
    assert error.known == ("google", "microsoft")
    assert "bogus" in str(error)
    assert "google" in str(error)


def test_unknown_provider_error_reads_well_with_no_known_providers() -> None:
    assert "none" in str(UnknownProviderError("bogus"))


def test_a_bare_provider_error_defaults_to_not_retryable() -> None:
    assert ProviderError("unclassified").disposition is RetryDisposition.PERMANENT
    assert ProviderError("unclassified").retryable is False


def test_adapter_errors_and_provider_errors_are_separate_hierarchies() -> None:
    assert issubclass(ProviderError, Exception)
    assert not issubclass(ProviderError, AdapterError)
    assert not issubclass(AdapterError, ProviderError)


@pytest.mark.parametrize("attempt", [1, 2, 5])
def test_transient_delay_is_always_positive(attempt: int) -> None:
    delay = retry_delay_for(TRANSIENT, attempt)
    assert delay is not None and delay > 0
