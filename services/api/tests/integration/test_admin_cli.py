import pytest
from httpx import AsyncClient

from atlas.auth.cli import ResetError, reset_password
from atlas.db import session_scope
from tests.conftest import create_user_via_setup


async def _login(client: AsyncClient, email: str, password: str) -> int:
    response = await client.post("/api/auth/login", json={"email": email, "password": password})
    return response.status_code


async def test_reset_sets_a_new_password_and_signs_every_session_out(client: AsyncClient) -> None:
    await create_user_via_setup(client, email="owner@example.com", password="old password 123")
    assert (await client.get("/api/auth/me")).status_code == 200

    async with session_scope() as session:
        revoked, devices = await reset_password(
            session, "Owner@Example.com", "brand new password 456"
        )
    assert revoked >= 1 and devices == 0

    assert (await client.get("/api/auth/me")).status_code == 401
    assert await _login(client, "owner@example.com", "old password 123") == 401
    assert await _login(client, "owner@example.com", "brand new password 456") == 200


async def test_reset_refuses_unknown_accounts_and_weak_passwords(client: AsyncClient) -> None:
    await create_user_via_setup(client, email="owner@example.com", password="old password 123")
    async with session_scope() as session:
        with pytest.raises(ResetError, match="no such active account"):
            await reset_password(session, "nobody@example.com", "brand new password 456")
        with pytest.raises(ResetError, match="characters"):
            await reset_password(session, "owner@example.com", "short")
    assert await _login(client, "owner@example.com", "old password 123") == 200
