from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from tests.conftest import create_user_via_setup, csrf_headers

PASSWORD = "correct horse battery"


async def test_setup_status_true_on_fresh_install(client: AsyncClient) -> None:
    response = await client.get("/api/setup/status")
    assert response.status_code == 200
    assert response.json() == {"setup_required": True, "recovery_enabled": True}


async def test_setup_creates_owner_and_session(client: AsyncClient) -> None:
    await create_user_via_setup(client, password=PASSWORD)
    assert "atlas_session" in client.cookies
    assert "atlas_csrf" in client.cookies

    status = await client.get("/api/setup/status")
    assert status.json() == {"setup_required": False, "recovery_enabled": True}

    me = await client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["email"] == "owner@example.com"


async def test_setup_is_rejected_once_initialised(client: AsyncClient) -> None:
    await create_user_via_setup(client, password=PASSWORD)
    again = await client.post(
        "/api/auth/setup",
        json={"email": "second@example.com", "password": PASSWORD, "display_name": "Second"},
    )
    assert again.status_code == 409


async def test_me_requires_authentication(app: FastAPI) -> None:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as anon:
        response = await anon.get("/api/auth/me")
    assert response.status_code == 401


async def test_login_rejects_wrong_password(client: AsyncClient) -> None:
    await create_user_via_setup(client, password=PASSWORD)
    response = await client.post(
        "/api/auth/login", json={"email": "owner@example.com", "password": "wrong-password"}
    )
    assert response.status_code == 401


async def test_login_succeeds_with_correct_password(client: AsyncClient) -> None:
    await create_user_via_setup(client, password=PASSWORD)
    response = await client.post(
        "/api/auth/login", json={"email": "owner@example.com", "password": PASSWORD}
    )
    assert response.status_code == 200
    assert response.json()["email"] == "owner@example.com"


async def test_logout_revokes_session(client: AsyncClient) -> None:
    await create_user_via_setup(client, password=PASSWORD)
    response = await client.post("/api/auth/logout", headers=csrf_headers(client))
    assert response.status_code == 204
    assert (await client.get("/api/auth/me")).status_code == 401


async def test_csrf_required_for_authenticated_writes(client: AsyncClient) -> None:
    await create_user_via_setup(client, password=PASSWORD)
    without = await client.post("/api/auth/logout")
    assert without.status_code == 403
    with_token = await client.post("/api/auth/logout", headers=csrf_headers(client))
    assert with_token.status_code == 204
