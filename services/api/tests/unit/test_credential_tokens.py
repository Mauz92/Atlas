"""Credential value objects and boundary validation (M5-01) — pure unit tests.

Verifies the log/error redaction guarantees and the input normalisation the service relies on.
"""

from __future__ import annotations

import dataclasses
from datetime import UTC, datetime, timedelta

import pytest

from atlas.calendar import (
    CredentialMetadata,
    CredentialProvider,
    CredentialValidationError,
    TokenBundle,
    clean_token,
    clean_token_type,
    ensure_bundle_has_token,
    normalise_expiry,
    normalise_provider,
    normalise_scopes,
)

ACCESS = "ya29.A0SUPERSECRETACCESS"
REFRESH = "1//0SUPERSECRETREFRESH"


def test_bundle_repr_and_str_redact_tokens() -> None:
    bundle = TokenBundle(access_token=ACCESS, refresh_token=REFRESH)
    for text in (repr(bundle), str(bundle), f"{bundle}"):
        assert ACCESS not in text
        assert REFRESH not in text
        assert "redacted" in text


def test_bundle_payload_round_trips() -> None:
    bundle = TokenBundle(access_token=ACCESS, refresh_token=REFRESH, token_type="Bearer")
    assert TokenBundle.from_payload(bundle.to_payload()) == bundle


def test_bundle_payload_rejects_garbage() -> None:
    with pytest.raises(CredentialValidationError):
        TokenBundle.from_payload(b"not-json")
    with pytest.raises(CredentialValidationError):
        TokenBundle.from_payload(b"[1, 2, 3]")


def test_metadata_holds_no_token_material() -> None:
    names = {field.name for field in dataclasses.fields(CredentialMetadata)}
    assert names.isdisjoint({"access_token", "refresh_token", "ciphertext", "token_type"})
    assert {"provider", "scopes", "access_expires_at", "has_refresh_token"} <= names


def test_normalise_provider_accepts_names_and_enum_members() -> None:
    assert normalise_provider("google") == "google"
    assert normalise_provider(CredentialProvider.MICROSOFT) == "microsoft"
    with pytest.raises(CredentialValidationError):
        normalise_provider("dropbox")


def test_normalise_scopes_trims_deduplicates_and_drops_blanks() -> None:
    assert normalise_scopes([" calendar.readonly ", "calendar.readonly", "", "openid"]) == [
        "calendar.readonly",
        "openid",
    ]
    assert normalise_scopes(None) == []


def test_normalise_scopes_is_bounded() -> None:
    with pytest.raises(CredentialValidationError):
        normalise_scopes(["x" * 257])
    with pytest.raises(CredentialValidationError):
        normalise_scopes([f"scope-{index}" for index in range(65)])


def test_clean_token_treats_blank_as_absent_and_bounds_length() -> None:
    assert clean_token(None, "access_token") is None
    assert clean_token("   ", "access_token") is None
    assert clean_token(ACCESS, "access_token") == ACCESS
    with pytest.raises(CredentialValidationError):
        clean_token("x" * 9000, "access_token")


def test_clean_token_type_defaults_and_bounds() -> None:
    assert clean_token_type(None) == "Bearer"
    assert clean_token_type("  ") == "Bearer"
    assert clean_token_type(" bearer ") == "bearer"
    with pytest.raises(CredentialValidationError):
        clean_token_type("x" * 100)


def test_normalise_expiry_makes_naive_instants_aware() -> None:
    naive = datetime(2026, 10, 26, 12, 0)
    assert normalise_expiry(naive) == naive.replace(tzinfo=UTC)
    aware = datetime(2026, 10, 26, 12, 0, tzinfo=UTC) + timedelta(hours=1)
    assert normalise_expiry(aware) == aware
    assert normalise_expiry(None) is None


def test_ensure_bundle_has_token_rejects_an_empty_bundle() -> None:
    ensure_bundle_has_token(TokenBundle(access_token=ACCESS))
    ensure_bundle_has_token(TokenBundle(refresh_token=REFRESH))
    with pytest.raises(CredentialValidationError):
        ensure_bundle_has_token(TokenBundle())


def test_upsert_schema_requires_a_token_and_is_bounded() -> None:
    from pydantic import ValidationError

    from atlas.api.schemas import (
        ProviderCredentialOut,
        ProviderCredentialRefreshRequest,
        ProviderCredentialUpsertRequest,
    )

    ProviderCredentialUpsertRequest(access_token="token")
    with pytest.raises(ValidationError):
        ProviderCredentialUpsertRequest()  # neither token
    with pytest.raises(ValidationError):
        ProviderCredentialUpsertRequest(access_token="")  # blank counts as absent
    with pytest.raises(ValidationError):
        ProviderCredentialUpsertRequest(access_token="x" * 9000)  # over the boundary
    with pytest.raises(ValidationError):
        ProviderCredentialRefreshRequest(access_token="")

    # The credential response shape carries no token/ciphertext fields.
    field_names = set(ProviderCredentialOut.model_fields)
    assert field_names.isdisjoint({"access_token", "refresh_token", "ciphertext"})
    assert {"provider", "scopes", "has_refresh_token", "key_id"} <= field_names
