"""Security scenarios for device credentials (SYNC-06; SECURITY.md T19-T22).

Token theft, a revoked or superseded token, cross-user isolation, the cookie/CSRF interaction
(the two authentication paths must stay separate), token hygiene in logs and errors, and the
password-reset and inactive-account behaviour. Real PostgreSQL.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select, text

from atlas.auth.devices import hash_device_token
from atlas.db import session_scope
from atlas.models import Device
from tests.conftest import create_user_via_setup, csrf_headers
from tests.integration.test_devices import (
    EMAIL,
    PASSWORD,
    bearer,
    new_client,
    sign_in,
    sync_headers,
)

pytestmark = pytest.mark.usefixtures("_db")

OTHER = "second@example.com"
OTHER_PASSWORD = "another long password"


@pytest.fixture
async def c(notes_client: AsyncClient) -> AsyncClient:
    await create_user_via_setup(notes_client, email=EMAIL, password=PASSWORD)
    return notes_client


async def second_user(app: FastAPI) -> AsyncClient:
    """A second account with a browser session of its own (made directly: setup is one-shot)."""
    from atlas.auth import generate_session_token, hash_password, hash_session_token
    from atlas.models import AuthSession, User

    token = generate_session_token()
    async with session_scope() as session:
        user = User(email=OTHER, display_name="Other", password_hash=hash_password(OTHER_PASSWORD))
        session.add(user)
        await session.flush()
        session.add(
            AuthSession(
                user_id=user.id,
                token_hash=hash_session_token(token),
                expires_at=(
                    await session.execute(text("SELECT now() + interval '1 day'"))
                ).scalar_one(),
            )
        )
    client = new_client(app)
    client.cookies.set("atlas_session", token)
    return client


# --- theft ------------------------------------------------------------------------------


async def test_a_stolen_token_works_until_revoked_and_then_never_again(app: FastAPI, c) -> None:
    victim, token, device = await sign_in(app, name="Victim laptop")
    thief = new_client(app)  # another machine, only the token
    created = await thief.post(
        "/api/tasks", json={"title": "planted"}, headers={**bearer(token), **sync_headers()}
    )
    assert created.status_code == 201  # what a bearer token is: possession is authority...
    # ...so the owner's remedy has to be immediate and complete
    assert (
        await c.delete(f"/api/devices/{device['id']}", headers=csrf_headers(c))
    ).status_code == 204
    for who in (thief, victim):
        r = await who.get("/api/tasks", headers=bearer(token))
        assert r.status_code == 401 and r.json()["error"] == "token_revoked"
    # a revoked device cannot rotate its way back in, nor sign itself in again without the password
    assert (
        await thief.post("/api/devices/current/rotate", headers=bearer(token))
    ).status_code == 401
    assert (await thief.get("/api/devices", headers=bearer(token))).status_code == 401


async def test_a_thief_with_a_device_token_cannot_lock_the_owner_out_or_reach_the_account(
    app: FastAPI, c
) -> None:
    _victim, token, _ = await sign_in(app)
    thief = new_client(app)
    for method, path, body in [
        ("POST", "/api/auth/password", {"current_password": "guess", "new_password": "x" * 14}),
        ("POST", "/api/devices/revoke-all", None),
        ("GET", "/api/export", None),
        ("GET", "/api/calendar/credentials", None),
        ("POST", "/api/calendar/accounts/google/connect", None),
        ("POST", "/api/calendar/feeds/preview", {"url": "https://example.com/a.ics"}),
    ]:
        r = await thief.request(method, path, json=body, headers=bearer(token))
        assert r.status_code == 403, (path, r.text)
    assert (
        await c.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    ).status_code == 200


async def test_a_device_can_read_calendar_events_but_not_manage_connections(
    app: FastAPI, c
) -> None:
    _dev, token, _ = await sign_in(app)
    client = new_client(app)
    window = {"start": "2026-11-01T00:00:00Z", "end": "2026-12-01T00:00:00Z"}
    assert (
        await client.get("/api/calendar/events", params=window, headers=bearer(token))
    ).status_code == 200
    assert (await client.get("/api/calendar/accounts", headers=bearer(token))).status_code == 200


async def test_a_rotated_away_token_cannot_be_used_after_the_new_one_is_seen(
    app: FastAPI, c
) -> None:
    dev, old, _ = await sign_in(app)
    new = (await dev.post("/api/devices/current/rotate")).json()["token"]
    assert (await new_client(app).get("/api/tasks", headers=bearer(new))).status_code == 200
    assert (await new_client(app).get("/api/tasks", headers=bearer(old))).status_code == 401


# --- isolation --------------------------------------------------------------------------


async def test_devices_and_data_are_user_scoped(app: FastAPI, c) -> None:
    mine, my_token, my_device = await sign_in(app, name="Mine")
    other = await second_user(app)
    theirs = new_client(app)
    r = await theirs.post(
        "/api/devices",
        json={"email": OTHER, "password": OTHER_PASSWORD, "name": "Theirs", "platform": "web"},
    )
    assert r.status_code == 201
    theirs.headers.update(bearer(r.json()["token"]))

    task = (await mine.post("/api/tasks", json={"title": "mine"}, headers=sync_headers())).json()
    assert (await theirs.get(f"/api/tasks/{task['id']}")).status_code == 404
    assert (await theirs.get("/api/tasks")).json() == {"tasks": []}

    # lists show only your own devices
    assert [d["name"] for d in (await mine.get("/api/devices")).json()["items"]] == ["Mine"]
    assert [d["name"] for d in (await theirs.get("/api/devices")).json()["items"]] == ["Theirs"]
    # the other account's browser cannot rename or revoke yours: a plain 404, nothing changes
    login = await other.post("/api/auth/login", json={"email": OTHER, "password": OTHER_PASSWORD})
    assert login.status_code == 200
    headers = csrf_headers(other)
    url = f"/api/devices/{my_device['id']}"
    assert (await other.patch(url, json={"name": "pwned"}, headers=headers)).status_code == 404
    assert (await other.delete(url, headers=headers)).status_code == 404
    revoked = await other.post("/api/devices/revoke-all", headers=headers)
    assert revoked.json() == {"revoked": 1}  # only their own
    assert (await mine.get("/api/tasks", headers=bearer(my_token))).status_code == 200
    assert (await theirs.get("/api/tasks")).status_code == 401
    async with session_scope() as session:
        rows = (await session.execute(select(Device))).scalars()
        names = {d.name: d.revoked_at is not None for d in rows}
    assert names == {"Mine": False, "Theirs": True}


# --- the two authentication paths stay separate -----------------------------------------


async def test_cookie_requests_still_need_csrf_with_or_without_an_authorization_header(
    app: FastAPI, c
) -> None:
    # unchanged: an unsafe cookie request without the CSRF header is refused
    assert (await c.post("/api/tasks", json={"title": "x"})).status_code == 403
    # a non-bearer Authorization header (a reverse proxy's Basic auth) does not lift the check...
    r = await c.post("/api/tasks", json={"title": "x"}, headers={"Authorization": "Basic dTpw"})
    assert r.status_code == 403
    # ...and does not break cookie authentication either
    ok = await c.post(
        "/api/tasks",
        json={"title": "x"},
        headers={"Authorization": "Basic dTpw", **csrf_headers(c)},
    )
    assert ok.status_code == 201
    assert (await c.get("/api/auth/me", headers={"Authorization": "Basic dTpw"})).status_code == 200


async def test_a_bad_bearer_token_is_never_rescued_by_a_session_cookie(app: FastAPI, c) -> None:
    """A cross-site request cannot add a header, but even if one carried both, the cookie is
    ignored once a bearer token is presented: it must not authenticate, and it must not make the
    (CSRF-exempt) bearer request succeed."""
    for token in ("atd_" + "A" * 43, "garbage", "", hash_device_token("x")):
        r = await c.post(
            "/api/tasks",
            json={"title": "should not exist"},
            headers={**bearer(token), **sync_headers()},
        )
        assert r.status_code == 401, token
        assert r.json()["error"] == "unauthenticated"
    async with session_scope() as session:
        assert (await session.execute(text("SELECT count(*) FROM tasks"))).scalar_one() == 0


async def test_a_session_cookie_cannot_ride_a_device_token_onto_account_endpoints(
    app: FastAPI, c
) -> None:
    """Cookie + valid bearer on a browser-only endpoint, no CSRF header: the request is the
    device's, not the browser's, so it is refused as out of scope. No password changes."""
    _dev, token, _ = await sign_in(app)
    r = await c.post(
        "/api/auth/password",
        json={"current_password": PASSWORD, "new_password": "attacker chosen 123"},
        headers=bearer(token),
    )
    assert r.status_code == 403 and r.json()["error"] == "forbidden_scope"
    assert (
        await new_client(app).post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    ).status_code == 200


async def test_a_session_token_is_not_a_device_token_and_vice_versa(app: FastAPI, c) -> None:
    session_token = c.cookies.get("atlas_session")
    assert session_token
    anon = new_client(app)
    assert (await anon.get("/api/tasks", headers=bearer(session_token))).status_code == 401
    _dev, token, _ = await sign_in(app)
    anon.cookies.set("atlas_session", token)
    assert (await anon.get("/api/tasks")).status_code == 401  # a device token in the cookie jar


async def test_a_device_request_sets_no_cookies(app: FastAPI, c) -> None:
    dev, _, _ = await sign_in(app)
    r = await dev.get("/api/tasks")
    assert "set-cookie" not in r.headers
    assert not dev.cookies


# --- token hygiene ----------------------------------------------------------------------


async def test_no_token_reaches_the_logs_or_an_error(app: FastAPI, c, caplog) -> None:
    caplog.set_level(logging.DEBUG)
    anon = new_client(app)
    r = await anon.post(
        "/api/devices", json={"email": EMAIL, "password": PASSWORD, "name": "log test"}
    )
    token = r.json()["token"]
    anon.headers.update(bearer(token))
    stranger = "atd_" + "Z" * 43
    seen: list[Any] = [
        await anon.get("/api/tasks"),
        await anon.get("/api/auth/me"),
        await anon.post("/api/devices/current/rotate"),
        await anon.get("/api/tasks", headers=bearer(stranger)),  # unknown token
        await anon.post("/api/auth/password", json={"current_password": "x"}),  # 403, 422 shapes
        await anon.delete("/api/devices/current"),
        await anon.get("/api/tasks"),  # revoked now
    ]
    rotated = seen[2].json()["token"]
    for response in seen:
        for secret in (token, stranger, rotated):
            if response is seen[2] and secret == rotated:
                continue  # the one place a token is returned
            assert secret not in response.text
            assert secret not in str(dict(response.headers))
    haystack = "\n".join(f"{record.getMessage()} {record.__dict__}" for record in caplog.records)
    for secret in (token, stranger, rotated, PASSWORD):
        assert secret not in haystack
    assert hash_device_token(token) not in haystack


async def test_the_database_holds_hashes_only_and_a_backup_row_is_useless_as_a_credential(
    app: FastAPI, c
) -> None:
    dev, token, _ = await sign_in(app)
    await dev.post("/api/devices/current/rotate")  # fills prev_token_hash too
    async with session_scope() as session:
        dump = (
            await session.execute(
                text("SELECT string_agg(row_to_json(d)::text, ' ') FROM devices d")
            )
        ).scalar_one()
        row = (await session.execute(select(Device))).scalar_one()
    assert token not in dump and "atd_" not in dump
    assert row.prev_token_hash == hash_device_token(token)
    # presenting a stored hash as a token does not work
    assert (
        await new_client(app).get("/api/tasks", headers=bearer(row.token_hash))
    ).status_code == 401
    assert (
        await new_client(app).get("/api/tasks", headers=bearer(row.prev_token_hash))
    ).status_code == 401


@pytest.mark.parametrize(
    "header",
    [
        "Bearer",
        "Bearer ",
        "bearer atd_",
        "Bearer " + "a" * 5000,
        "Bearer atd_" + "A" * 43 + " extra",
        "Bearer atd_" + "A" * 42 + "é",
        "Bearer   ",
    ],
)
async def test_malformed_authorization_headers_are_plain_401s(app: FastAPI, c, header: str) -> None:
    anon = new_client(app)
    try:
        r = await anon.get("/api/tasks", headers={"Authorization": header})
    except (UnicodeEncodeError, ValueError):  # not even sendable
        return
    assert r.status_code == 401
    assert r.json()["error"] == "unauthenticated"


async def test_the_bearer_scheme_is_case_insensitive_but_the_token_is_exact(
    app: FastAPI, c
) -> None:
    _dev, token, _ = await sign_in(app)
    anon = new_client(app)
    assert (
        await anon.get("/api/tasks", headers={"Authorization": f"bearer {token}"})
    ).status_code == 200
    flipped = token[:-1] + ("A" if token[-1] != "A" else "B")
    assert (await anon.get("/api/tasks", headers=bearer(flipped))).status_code == 401


# --- accounts ---------------------------------------------------------------------------


async def test_a_deactivated_account_loses_its_devices(app: FastAPI, c) -> None:
    dev, _, _ = await sign_in(app)
    assert (await dev.get("/api/tasks")).status_code == 200
    async with session_scope() as session:
        await session.execute(text("UPDATE users SET is_active = false"))
    r = await dev.get("/api/tasks")
    assert r.status_code == 401 and r.json()["error"] == "unauthenticated"


async def test_deleting_the_account_removes_its_devices(app: FastAPI, c) -> None:
    await sign_in(app)
    async with session_scope() as session:
        await session.execute(text("DELETE FROM users"))
        assert (await session.execute(text("SELECT count(*) FROM devices"))).scalar_one() == 0


async def test_device_ids_are_random_uuids_not_guessable_handles(app: FastAPI, c) -> None:
    _a, _, first = await sign_in(app)
    _b, _, second = await sign_in(app)
    assert uuid.UUID(first["id"]).version == 4 and uuid.UUID(second["id"]).version == 4


async def test_a_backup_carries_the_devices_as_hashes_only(
    app: FastAPI, c, tmp_path, notes_storage
) -> None:
    """The table is part of the one database, so every backup holds it; the dump holds hashes, so
    a leaked backup file does not hand out working credentials."""
    import os

    from atlas.backups import BackupConfig, BackupService
    from tests.integration.test_backups import _dump_backend_kwargs

    _dev, token, device = await sign_in(app, name="Backed-up device")
    config = BackupConfig(
        destination=tmp_path / "backups",
        notes_root=notes_storage.root,
        database_url=os.environ["DATABASE_URL"],
        retain=1,
        **_dump_backend_kwargs(),
    )
    dump = (BackupService(config).run().directory / "database.sql").read_text(encoding="utf-8")
    assert "CREATE TABLE public.devices" in dump
    block = dump.split("COPY public.devices", 1)[1].split("\\.\n", 1)[0]
    assert device["id"] in block and hash_device_token(token) in block
    assert token not in dump and "atd_" not in dump
