"""Provider-credentials API against a real PostgreSQL (M5-01).

End-to-end over HTTP: store a credential, read it back decrypted through the service, confirm the
database holds ciphertext (never the plaintext token), update it, delete it, and that the store is
strictly user-scoped and leaks nothing on the error paths.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

import pytest
from sqlalchemy import select, text

from atlas.calendar import (
    CredentialNotFoundError,
    ProviderCredentialsService,
    TokenBundle,
    TokenCipher,
)
from atlas.config import get_settings
from atlas.db import session_scope
from atlas.models import ProviderCredential, User
from tests.conftest import create_user_via_setup, csrf_headers

if TYPE_CHECKING:
    from httpx import AsyncClient

ACCESS = "ya29.SUPERSECRETACCESS"
REFRESH = "1//SUPERSECRETREFRESH"


async def _auth(client: AsyncClient) -> dict[str, str]:
    await create_user_via_setup(client)
    return csrf_headers(client)


async def _user_id() -> uuid.UUID:
    async with session_scope() as session:
        return (await session.execute(select(User))).scalars().one().id


async def _raw_ciphertext(provider: str) -> bytes:
    async with session_scope() as session:
        value = (
            await session.execute(
                text("SELECT ciphertext FROM provider_credentials WHERE provider = :provider"),
                {"provider": provider},
            )
        ).scalar_one()
    return bytes(value)


async def _count_rows() -> int:
    async with session_scope() as session:
        return (
            await session.execute(text("SELECT count(*) FROM provider_credentials"))
        ).scalar_one()


def _parse(value: str) -> datetime:
    """Parse an API instant (serialised with a ``Z`` suffix) back to an aware datetime."""
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


async def test_credentials_require_authentication(client: AsyncClient) -> None:
    assert (await client.get("/api/calendar/credentials")).status_code == 401
    assert (await client.get("/api/calendar/credentials/google")).status_code == 401
    assert (
        await client.put("/api/calendar/credentials/google", json={"access_token": "x"})
    ).status_code == 401
    assert (await client.delete("/api/calendar/credentials/google")).status_code == 401


async def test_writes_require_csrf(client: AsyncClient) -> None:
    await create_user_via_setup(client)
    response = await client.put("/api/calendar/credentials/google", json={"access_token": ACCESS})
    assert response.status_code == 403


async def test_store_read_and_metadata_never_expose_tokens(client: AsyncClient) -> None:
    headers = await _auth(client)
    expires = datetime(2026, 10, 26, 15, 30, tzinfo=UTC)

    stored = await client.put(
        "/api/calendar/credentials/google",
        json={
            "access_token": ACCESS,
            "refresh_token": REFRESH,
            "scopes": ["https://www.googleapis.com/auth/calendar.readonly", "openid"],
            "access_expires_at": expires.isoformat(),
        },
        headers=headers,
    )
    assert stored.status_code == 200, stored.text
    body = stored.json()
    assert body["provider"] == "google"
    assert body["has_refresh_token"] is True
    assert body["key_id"] == "v1"
    assert body["scopes"] == [
        "https://www.googleapis.com/auth/calendar.readonly",
        "openid",
    ]
    assert _parse(body["access_expires_at"]) == expires
    # Token material never appears in the response.
    assert ACCESS not in stored.text
    assert REFRESH not in stored.text
    assert "ciphertext" not in stored.text

    fetched = await client.get("/api/calendar/credentials/google")
    assert fetched.status_code == 200
    assert fetched.json()["scopes"] == [
        "https://www.googleapis.com/auth/calendar.readonly",
        "openid",
    ]
    assert ACCESS not in fetched.text

    listing = await client.get("/api/calendar/credentials")
    assert [item["provider"] for item in listing.json()["credentials"]] == ["google"]


async def test_database_stores_ciphertext_not_the_plaintext_token(client: AsyncClient) -> None:
    headers = await _auth(client)
    owner = await _user_id()
    await client.put(
        "/api/calendar/credentials/google",
        json={"access_token": ACCESS, "refresh_token": REFRESH},
        headers=headers,
    )

    raw = await _raw_ciphertext("google")
    assert ACCESS.encode() not in raw
    assert REFRESH.encode() not in raw
    # The encryption key is never stored in the row either.
    assert get_settings().token_encryption_key.encode() not in raw

    # The service (the only reader) can still recover the exact tokens.
    async with session_scope() as session:
        stored = await ProviderCredentialsService(session, owner).read("google")
    assert stored.tokens.access_token == ACCESS
    assert stored.tokens.refresh_token == REFRESH
    assert stored.metadata.provider == "google"
    assert stored.metadata.key_id == "v1"


async def test_upsert_replaces_and_keeps_exactly_one_row_per_provider(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    await client.put(
        "/api/calendar/credentials/google",
        json={"access_token": "first", "scopes": ["a"]},
        headers=headers,
    )
    second = await client.put(
        "/api/calendar/credentials/google",
        json={"access_token": "second", "refresh_token": REFRESH, "scopes": ["b", "c"]},
        headers=headers,
    )
    assert second.status_code == 200
    assert second.json()["scopes"] == ["b", "c"]

    assert await _count_rows() == 1
    listing = (await client.get("/api/calendar/credentials")).json()["credentials"]
    assert len(listing) == 1
    raw = await _raw_ciphertext("google")
    assert b"first" not in raw
    assert b"second" not in raw


async def test_refresh_updates_tokens_and_expiry(client: AsyncClient) -> None:
    headers = await _auth(client)
    owner = await _user_id()
    await client.put(
        "/api/calendar/credentials/google",
        json={"access_token": "old-access", "refresh_token": REFRESH},
        headers=headers,
    )
    new_expiry = datetime(2026, 10, 26, 16, 0, tzinfo=UTC)
    refreshed = await client.post(
        "/api/calendar/credentials/google/refresh",
        json={"access_token": "new-access", "access_expires_at": new_expiry.isoformat()},
        headers=headers,
    )
    assert refreshed.status_code == 200, refreshed.text
    assert _parse(refreshed.json()["access_expires_at"]) == new_expiry
    assert refreshed.json()["has_refresh_token"] is True

    raw = await _raw_ciphertext("google")
    assert b"new-access" not in raw
    assert b"old-access" not in raw

    # The stored refresh token is preserved when the refresh does not re-issue one.
    async with session_scope() as session:
        service = ProviderCredentialsService(session, owner)
        stored = await service.read("google")
    assert stored.tokens.access_token == "new-access"
    assert stored.tokens.refresh_token == REFRESH

    missing = await client.post(
        "/api/calendar/credentials/microsoft/refresh",
        json={"access_token": "x"},
        headers=headers,
    )
    assert missing.status_code == 404


async def test_delete_removes_the_credential(client: AsyncClient) -> None:
    headers = await _auth(client)
    await client.put(
        "/api/calendar/credentials/google", json={"access_token": ACCESS}, headers=headers
    )

    deleted = await client.delete("/api/calendar/credentials/google", headers=headers)
    assert deleted.status_code == 204
    assert (await client.get("/api/calendar/credentials/google")).status_code == 404
    assert (await client.get("/api/calendar/credentials")).json()["credentials"] == []
    assert await _count_rows() == 0
    # Deleting again is a plain 404.
    again = await client.delete("/api/calendar/credentials/google", headers=headers)
    assert again.status_code == 404


async def test_credentials_are_strictly_user_scoped(client: AsyncClient) -> None:
    headers = await _auth(client)
    await client.put(
        "/api/calendar/credentials/google",
        json={"access_token": "mine", "scopes": ["owner-scope"]},
        headers=headers,
    )

    async with session_scope() as session:
        other = User(
            id=uuid.uuid4(),
            email=f"{uuid.uuid4()}@example.com",
            display_name="Other",
            password_hash="not-used",
        )
        session.add(other)
        await session.flush()
        other_id = other.id
        service = ProviderCredentialsService(session, other_id)
        await service.upsert(
            "google",
            tokens=TokenBundle(access_token="other-access"),
            scopes=["other-scope"],
        )

    # The other user's credential exists in the database (two rows)...
    assert await _count_rows() == 2
    # ...but the caller only ever sees their own.
    listing = (await client.get("/api/calendar/credentials")).json()["credentials"]
    assert len(listing) == 1
    assert listing[0]["scopes"] == ["owner-scope"]

    async with session_scope() as session:
        other_service = ProviderCredentialsService(session, other_id)
        stolen = await other_service.read("google")
    assert stolen.tokens.access_token == "other-access"
    assert stolen.metadata.scopes == ("other-scope",)


async def test_service_rejects_cross_user_access(client: AsyncClient) -> None:
    headers = await _auth(client)
    await client.put(
        "/api/calendar/credentials/google", json={"access_token": ACCESS}, headers=headers
    )

    intruder = uuid.uuid4()
    async with session_scope() as session:
        service = ProviderCredentialsService(session, intruder)
        with pytest.raises(CredentialNotFoundError):
            await service.read("google")
        with pytest.raises(CredentialNotFoundError):
            await service.delete("google")
        assert await service.list_metadata() == []


async def test_unknown_provider_is_rejected(client: AsyncClient) -> None:
    headers = await _auth(client)
    response = await client.put(
        "/api/calendar/credentials/dropbox", json={"access_token": "x"}, headers=headers
    )
    assert response.status_code == 422


async def test_tampered_ciphertext_fails_safely_without_leaking(client: AsyncClient) -> None:
    headers = await _auth(client)
    await client.put(
        "/api/calendar/credentials/google", json={"access_token": ACCESS}, headers=headers
    )
    async with session_scope() as session:
        await session.execute(
            text("UPDATE provider_credentials SET ciphertext = :blob WHERE provider = 'google'"),
            {"blob": b"tampered-not-a-real-ciphertext"},
        )

    response = await client.get("/api/calendar/credentials/google")
    assert response.status_code == 500
    assert response.json()["detail"] == "stored credential could not be decrypted"
    assert ACCESS not in response.text


async def test_validation_errors_do_not_echo_token_material(client: AsyncClient) -> None:
    headers = await _auth(client)
    huge_token = "S" + ("ecret" * 2000)
    response = await client.put(
        "/api/calendar/credentials/google",
        json={"access_token": huge_token},
        headers=headers,
    )
    assert response.status_code == 422
    assert huge_token not in response.text

    # A body with no token at all is also rejected without side effects.
    empty = await client.put(
        "/api/calendar/credentials/google", json={"scopes": ["a"]}, headers=headers
    )
    assert empty.status_code == 422
    assert await _count_rows() == 0


async def test_a_row_sealed_with_a_previous_key_is_still_readable(client: AsyncClient) -> None:
    """Rotation evidence: an old row decrypts while new writes use the active key."""
    await _auth(client)
    owner = await _user_id()
    settings = get_settings()
    previous = TokenCipher({"v0": "rotated-out-material"}, active_key_id="v0")
    bundle = TokenBundle(access_token="old-key-access", refresh_token=REFRESH)
    blob = previous.encrypt(
        bundle.to_payload(), aad=f"provider-credentials:{owner}:google".encode()
    )

    async with session_scope() as session:
        session.add(
            ProviderCredential(
                user_id=owner, provider="google", key_id="v0", ciphertext=blob, scopes=["a"]
            )
        )
        await session.flush()

    rotated = TokenCipher(
        {"v0": "rotated-out-material", "v1": settings.token_encryption_key}, active_key_id="v1"
    )
    async with session_scope() as session:
        service = ProviderCredentialsService(session, owner, cipher=rotated)
        stored = await service.read("google")
        assert stored.tokens.access_token == "old-key-access"
        assert stored.metadata.key_id == "v0"

        # Refreshing re-seals the row with the active key.
        await service.refresh("google", access_token="rotated-access")
        row = (
            await session.execute(
                select(ProviderCredential).where(ProviderCredential.provider == "google")
            )
        ).scalar_one()
        assert row.key_id == "v1"
        assert (await service.read("google")).tokens.access_token == "rotated-access"


async def test_expiry_and_scopes_round_trip_through_the_database(client: AsyncClient) -> None:
    headers = await _auth(client)
    access_expiry = datetime(2026, 10, 26, 12, 0, tzinfo=UTC)
    refresh_expiry = access_expiry + timedelta(days=7)
    await client.put(
        "/api/calendar/credentials/microsoft",
        json={
            "access_token": ACCESS,
            "refresh_token": REFRESH,
            "scopes": ["Calendars.Read", "offline_access"],
            "access_expires_at": access_expiry.isoformat(),
            "refresh_expires_at": refresh_expiry.isoformat(),
        },
        headers=headers,
    )

    async with session_scope() as session:
        row = (
            await session.execute(
                select(ProviderCredential).where(ProviderCredential.provider == "microsoft")
            )
        ).scalar_one()
        assert row.scopes == ["Calendars.Read", "offline_access"]
        assert row.access_expires_at == access_expiry
        assert row.refresh_expires_at == refresh_expiry
