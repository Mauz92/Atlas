"""Account editing and instance info for the Settings page (MU-08, ADR-0050)."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from atlas.auth import hash_password
from atlas.backups.manifest import build_manifest, write_manifest
from atlas.config import get_settings
from atlas.db import session_scope
from atlas.models import User
from tests.conftest import create_user_via_setup, csrf_headers

OLD = "correct horse battery"
NEW = "a brand new passphrase"


async def _second_client(app: FastAPI, email: str, password: str) -> AsyncClient:
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    response = await client.post("/api/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    return client


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("PATCH", "/api/auth/me", {"display_name": "X"}),
        ("POST", "/api/auth/password", {"current_password": OLD, "new_password": NEW}),
        ("GET", "/api/instance", None),
    ],
)
async def test_account_and_instance_endpoints_require_a_session(
    app: FastAPI, method: str, path: str, body: dict[str, str] | None
) -> None:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as anon:
        response = await anon.request(method, path, json=body)
    assert response.status_code == 401


async def test_display_name_is_trimmed_validated_and_persisted(client: AsyncClient) -> None:
    await create_user_via_setup(client)
    headers = csrf_headers(client)
    ok = await client.patch("/api/auth/me", json={"display_name": "  Ada  "}, headers=headers)
    assert ok.status_code == 200
    assert (await client.get("/api/auth/me")).json()["display_name"] == "Ada"

    blank = await client.patch("/api/auth/me", json={"display_name": "   "}, headers=headers)
    assert blank.status_code == 422
    assert "Name must not be blank" in blank.text
    assert (await client.get("/api/auth/me")).json()["display_name"] == "Ada"

    no_csrf = await client.patch("/api/auth/me", json={"display_name": "Eve"})
    assert no_csrf.status_code == 403


@pytest.mark.parametrize(
    ("current", "new", "status", "message"),
    [
        (OLD, "short", 422, "at least 12 characters"),
        ("not the password", NEW, 400, "Current password is incorrect"),
        (OLD, OLD, 400, "must differ"),
    ],
)
async def test_password_change_rejections_leave_the_password_unchanged(
    client: AsyncClient, current: str, new: str, status: int, message: str
) -> None:
    await create_user_via_setup(client, password=OLD)
    response = await client.post(
        "/api/auth/password",
        json={"current_password": current, "new_password": new},
        headers=csrf_headers(client),
    )
    assert response.status_code == status
    assert message in response.text
    # Neither password is echoed back, even in the framework's validation error body.
    assert current not in response.text or (current == OLD and status == 400)
    assert "input" not in response.text
    login = await client.post(
        "/api/auth/login", json={"email": "owner@example.com", "password": OLD}
    )
    assert login.status_code == 200


async def test_password_change_revokes_other_sessions_keeps_this_one_and_is_scoped(
    app: FastAPI, client: AsyncClient
) -> None:
    await create_user_via_setup(client, password=OLD)
    async with session_scope() as session:
        session.add(
            User(
                id=uuid.uuid4(),
                email="other@example.com",
                display_name="Other",
                password_hash=hash_password("other account password"),
            )
        )
    other_device = await _second_client(app, "owner@example.com", OLD)
    other_user = await _second_client(app, "other@example.com", "other account password")
    try:
        response = await client.post(
            "/api/auth/password",
            json={"current_password": OLD, "new_password": NEW},
            headers=csrf_headers(client),
        )
        assert response.status_code == 204
        # This browser got a fresh session and stays signed in; the other device must sign in again.
        assert (await client.get("/api/auth/me")).status_code == 200
        assert (await other_device.get("/api/auth/me")).status_code == 401
        assert (await other_user.get("/api/auth/me")).status_code == 200
        old = await client.post(
            "/api/auth/login", json={"email": "owner@example.com", "password": OLD}
        )
        new = await client.post(
            "/api/auth/login", json={"email": "owner@example.com", "password": NEW}
        )
        assert (old.status_code, new.status_code) == (401, 200)
    finally:
        await other_device.aclose()
        await other_user.aclose()


async def test_password_attempts_are_rate_limited_like_login(client: AsyncClient) -> None:
    await create_user_via_setup(client, password=OLD)
    body = {"current_password": "wrong password!", "new_password": NEW}
    limit = get_settings().auth_rate_limit_per_minute
    codes = [
        (
            await client.post("/api/auth/password", json=body, headers=csrf_headers(client))
        ).status_code
        for _ in range(limit + 1)
    ]
    assert codes == [400] * limit + [429]


async def test_instance_info_reports_version_revision_and_backup_state_without_secrets(
    client: AsyncClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    await create_user_via_setup(client)
    destination = tmp_path / "backups"
    monkeypatch.setattr(get_settings(), "backup_dir", str(destination))

    absent = (await client.get("/api/instance")).json()
    assert absent["backups"]["destination_available"] is False
    assert absent["backups"]["sets"] == 0
    assert absent["backups"]["latest"] is None
    assert absent["database"] == "ok"
    assert absent["migration_revision"]

    published = destination / "atlas-backup-20261101T000000Z-abcd1234"
    published.mkdir(parents=True)
    write_manifest(
        published / "manifest.json",
        build_manifest(
            backup_id="20261101T000000Z-abcd1234",
            created_at=datetime(2026, 11, 1, tzinfo=UTC),
            atlas_version="9.9.9",
            parts={
                "database": {"store": "postgresql", "file": "database.sql", "bytes": 12},
                "notes": {"store": "markdown", "file": "notes.tar.gz", "bytes": 34},
            },
        ),
    )
    (destination / ".staging" / "interrupted").mkdir(parents=True)

    response = await client.get("/api/instance")
    info = response.json()
    assert info["version"] == absent["version"]
    backups = info["backups"]
    assert backups["destination_available"] is True
    assert backups["sets"] == 1
    assert backups["incomplete_sets"] == 1
    assert backups["latest"]["backup_id"] == "20261101T000000Z-abcd1234"
    assert backups["latest"]["database_bytes"] == 12
    assert backups["latest"]["notes_bytes"] == 34
    # No secret, path or connection string leaves the server.
    text = json.dumps(info)
    for forbidden in (str(tmp_path), get_settings().database_url, get_settings().secret_key):
        assert forbidden not in text
