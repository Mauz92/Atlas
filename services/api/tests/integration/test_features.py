"""Optional feature switches and the server-side TTRPG guard (TTRPG-01)."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from atlas.auth import hash_password
from atlas.db import session_scope
from atlas.models import User, UserFeature
from tests.conftest import create_user_via_setup, csrf_headers

PASSWORD = "another horse battery"


async def _second_client(app: FastAPI) -> AsyncClient:
    async with session_scope() as session:
        session.add(
            User(email="two@example.com", display_name="Two", password_hash=hash_password(PASSWORD))
        )
    other = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    response = await other.post(
        "/api/auth/login", json={"email": "two@example.com", "password": PASSWORD}
    )
    assert response.status_code == 200, response.text
    return other


async def test_features_require_a_session(app: FastAPI) -> None:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as anon:
        assert (await anon.get("/api/features")).status_code == 401
        assert (await anon.get("/api/ttrpg/status")).status_code == 401


async def test_a_fresh_account_has_ttrpg_off_and_its_routes_are_blocked(
    client: AsyncClient,
) -> None:
    await create_user_via_setup(client)
    assert (await client.get("/api/features")).json() == {"ttrpg": False}
    assert (await client.get("/api/ttrpg/status")).status_code == 404
    # No row was created by merely looking.
    async with session_scope() as session:
        assert (await session.execute(select(UserFeature))).first() is None


async def test_enabling_is_idempotent_and_opens_the_routes_and_disabling_closes_them(
    client: AsyncClient,
) -> None:
    await create_user_via_setup(client)
    headers = csrf_headers(client)
    for _ in range(2):
        on = await client.put("/api/features/ttrpg", json={"enabled": True}, headers=headers)
        assert on.status_code == 200
        assert on.json() == {"ttrpg": True}
    assert (await client.get("/api/ttrpg/status")).status_code == 200

    off = await client.put("/api/features/ttrpg", json={"enabled": False}, headers=headers)
    assert off.json() == {"ttrpg": False}
    assert (await client.get("/api/ttrpg/status")).status_code == 404
    # The switch is retained (disabled, not deleted) and can be turned back on.
    async with session_scope() as session:
        rows = (await session.execute(select(UserFeature))).scalars().all()
        assert [(row.feature, row.enabled) for row in rows] == [("ttrpg", False)]
    await client.put("/api/features/ttrpg", json={"enabled": True}, headers=headers)
    assert (await client.get("/api/ttrpg/status")).status_code == 200


@pytest.mark.parametrize(
    ("feature", "body", "status"),
    [
        ("nonsense", {"enabled": True}, 404),
        ("ttrpg", {"enabled": "maybe"}, 422),
        ("ttrpg", {"enabled": True, "extra": 1}, 422),
    ],
)
async def test_invalid_switch_requests_are_rejected(
    client: AsyncClient, feature: str, body: dict[str, object], status: int
) -> None:
    await create_user_via_setup(client)
    response = await client.put(f"/api/features/{feature}", json=body, headers=csrf_headers(client))
    assert response.status_code == status
    assert (await client.get("/api/features")).json() == {"ttrpg": False}


async def test_switching_needs_the_csrf_token(client: AsyncClient) -> None:
    await create_user_via_setup(client)
    response = await client.put("/api/features/ttrpg", json={"enabled": True})
    assert response.status_code == 403
    assert (await client.get("/api/features")).json() == {"ttrpg": False}


async def test_a_switch_belongs_to_one_account(app: FastAPI, client: AsyncClient) -> None:
    await create_user_via_setup(client)
    await client.put("/api/features/ttrpg", json={"enabled": True}, headers=csrf_headers(client))
    other = await _second_client(app)
    try:
        assert (await other.get("/api/features")).json() == {"ttrpg": False}
        assert (await other.get("/api/ttrpg/status")).status_code == 404
    finally:
        await other.aclose()
    assert (await client.get("/api/ttrpg/status")).status_code == 200


async def test_a_device_reads_the_switches_and_uses_the_module_but_cannot_change_a_switch(
    app: FastAPI, client: AsyncClient
) -> None:
    from tests.integration.test_devices import sign_in

    await create_user_via_setup(client)
    dev, _token, _ = await sign_in(app)
    off = await dev.get("/api/features")
    assert off.status_code == 200 and off.json() == {"ttrpg": False}
    assert (await dev.get("/api/ttrpg/status")).status_code == 404  # still off for this account
    # switching is account-level: refused for a device, whatever the body
    refused = await dev.put("/api/features/ttrpg", json={"enabled": True})
    assert refused.status_code == 403
    assert (await client.get("/api/features")).json() == {"ttrpg": False}

    await client.put("/api/features/ttrpg", json={"enabled": True}, headers=csrf_headers(client))
    assert (await dev.get("/api/features")).json() == {"ttrpg": True}
    assert (await dev.get("/api/ttrpg/status")).status_code == 200
    created = await dev.post("/api/ttrpg/creatures", json={"name": "Orc", "ac": 13, "hp": 15})
    assert created.status_code == 201, created.text
    # the browser sees the same data: one account, one store
    names = [c["name"] for c in (await client.get("/api/ttrpg/creatures")).json()["items"]]
    assert names == ["Orc"]
