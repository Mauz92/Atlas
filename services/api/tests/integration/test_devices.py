"""Device credentials: sign-in, list, rename, revoke, rotation, scope, rate limits (SYNC-06).

Real PostgreSQL. The browser is the cookie-session client (``c``); a device is a separate client
with no cookies that sends ``Authorization: Bearer``. The security-focused scenarios (token theft,
cookie/CSRF interaction, isolation, logs) are in ``test_device_security.py``.
"""

from __future__ import annotations

import base64
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.routing import APIRoute
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, text, update

from atlas.auth.devices import hash_device_token, looks_like_device_token, reset_touch_cache
from atlas.db import session_scope
from atlas.models import Device
from tests.conftest import create_user_via_setup, csrf_headers

pytestmark = pytest.mark.usefixtures("_db")

EMAIL = "owner@example.com"
PASSWORD = "correct horse battery"


@pytest.fixture
async def c(notes_client: AsyncClient) -> AsyncClient:
    await create_user_via_setup(notes_client, email=EMAIL, password=PASSWORD)
    return notes_client


def new_client(app: FastAPI) -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def sign_in(
    app: FastAPI,
    *,
    name: str = "Laptop",
    platform: str = "linux",
    email: str = EMAIL,
    password: str = PASSWORD,
) -> tuple[AsyncClient, str, dict[str, Any]]:
    """A cookie-less client signed in as a device: ``(client, token, device)``."""
    client = new_client(app)
    r = await client.post(
        "/api/devices",
        json={"email": email, "password": password, "name": name, "platform": platform},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    client.headers["Authorization"] = f"Bearer {body['token']}"
    return client, body["token"], body["device"]


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def sync_headers(extra: dict[str, str] | None = None) -> dict[str, str]:
    return {"Atlas-Sync": "1", "Idempotency-Key": str(uuid.uuid4()), **(extra or {})}


# --- sign-in -----------------------------------------------------------------------------------


async def test_sign_in_returns_the_token_once_and_stores_only_its_hash(app: FastAPI, c) -> None:
    client, token, device = await sign_in(app, name="  Kim's   laptop ", platform="linux")
    assert looks_like_device_token(token)
    raw = base64.urlsafe_b64decode(token.removeprefix("atd_") + "=")
    assert len(raw) == 32  # 256 random bits
    assert device["name"] == "Kim's laptop" and device["platform"] == "linux"
    assert device["last_seen_at"] is None and device["revoked_at"] is None
    assert device["current"] is False
    async with session_scope() as session:
        row = (await session.execute(select(Device))).scalar_one()
        assert row.token_hash == hash_device_token(token) != token
        dump = await session.execute(text("SELECT row_to_json(d)::text FROM devices d"))
        assert token not in dump.scalar_one()  # not in any column
    # the token is not shown again by anything
    listed = await client.get("/api/devices")
    assert token not in listed.text and "token" not in listed.json()["items"][0]
    two = await new_client(app).post(
        "/api/devices", json={"email": EMAIL, "password": PASSWORD, "name": "B"}
    )
    assert two.json()["token"] != token


async def test_sign_in_does_not_need_a_session_or_csrf_and_leaves_no_cookie(
    app: FastAPI, c
) -> None:
    client = new_client(app)
    r = await client.post("/api/devices", json={"email": EMAIL, "password": PASSWORD, "name": "x"})
    assert r.status_code == 201
    assert "set-cookie" not in r.headers
    assert r.headers["cache-control"] == "no-store"


async def test_wrong_password_and_unknown_account_are_the_same_401(app: FastAPI, c) -> None:
    client = new_client(app)
    wrong = await client.post(
        "/api/devices", json={"email": EMAIL, "password": "nope nope nope", "name": "x"}
    )
    unknown = await client.post(
        "/api/devices", json={"email": "nobody@example.com", "password": PASSWORD, "name": "x"}
    )
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json() == unknown.json() == {"detail": "Invalid credentials"}
    async with session_scope() as session:
        assert (await session.execute(select(Device))).first() is None


async def test_sign_in_shares_the_login_rate_limit(app: FastAPI, c) -> None:
    client = new_client(app)
    statuses = []
    for _ in range(12):
        r = await client.post(
            "/api/devices", json={"email": EMAIL, "password": "wrong wrong wrong", "name": "x"}
        )
        statuses.append(r.status_code)
    # (the account setup in the fixture already spent one of the ten)
    assert statuses[:9] == [401] * 9 and set(statuses[9:]) == {429}
    # the budget is one pool: a login from the same address is limited too
    login = await client.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    assert login.status_code == 429
    # and a correct password is refused while limited (no oracle)
    ok = await client.post("/api/devices", json={"email": EMAIL, "password": PASSWORD, "name": "x"})
    assert ok.status_code == 429


@pytest.mark.parametrize(
    "body",
    [
        {"platform": "toaster"},
        {"name": ""},
        {"name": "   "},
        {"name": "a\u0000b"},
        {"name": "x" * 81},
        {"email": "not-an-email"},
    ],
)
async def test_sign_in_validation_never_echoes_the_password(app: FastAPI, c, body) -> None:
    secret = "a very secret password 987"
    r = await new_client(app).post(
        "/api/devices",
        json={"email": EMAIL, "password": secret, "name": "x", "platform": "linux", **body},
    )
    assert r.status_code == 422
    assert secret not in r.text


async def test_an_inactive_account_cannot_sign_a_device_in(app: FastAPI, c) -> None:
    async with session_scope() as session:
        await session.execute(text("UPDATE users SET is_active = false"))
    r = await new_client(app).post(
        "/api/devices", json={"email": EMAIL, "password": PASSWORD, "name": "x"}
    )
    assert r.status_code == 401


async def test_the_number_of_signed_in_devices_is_bounded(app: FastAPI, c) -> None:
    from atlas.auth.devices import MAX_ACTIVE_DEVICES

    async with session_scope() as session:
        user_id = (await session.execute(text("SELECT id FROM users"))).scalar_one()
        for i in range(MAX_ACTIVE_DEVICES):
            session.add(
                Device(user_id=user_id, name=f"d{i}", platform="other", token_hash=f"{i:064d}")
            )
    r = await new_client(app).post(
        "/api/devices", json={"email": EMAIL, "password": PASSWORD, "name": "one too many"}
    )
    assert r.status_code == 409 and "Settings" in r.json()["detail"]
    # revoking one makes room again
    async with session_scope() as session:
        await session.execute(
            update(Device).where(Device.name == "d0").values(revoked_at=datetime.now(UTC))
        )
    r = await new_client(app).post(
        "/api/devices", json={"email": EMAIL, "password": PASSWORD, "name": "fits now"}
    )
    assert r.status_code == 201


# --- using the token ---------------------------------------------------------------------------


async def test_a_device_syncs_the_data_endpoints_without_cookies_or_csrf(app: FastAPI, c) -> None:
    dev, _token, _ = await sign_in(app)
    created = await dev.post("/api/tasks", json={"title": "from device"}, headers=sync_headers())
    assert created.status_code == 201, created.text
    task_id = created.json()["id"]
    # the browser sees the same data: one account, one store
    assert (await c.get(f"/api/tasks/{task_id}")).json()["title"] == "from device"
    for path in (
        "/api/tasks",
        "/api/projects",
        "/api/notes",
        "/api/changes?since=0",
        "/api/tasks/changes?since=0",
        "/api/sync/resolutions",
        "/api/search?q=device",
        "/api/instance",
        "/api/auth/me",
    ):
        r = await dev.get(path, headers={"Atlas-Sync": "1"})
        assert r.status_code == 200, (path, r.status_code, r.text)
    assert (await dev.get("/api/auth/me")).json()["email"] == EMAIL
    # sync mode: Atlas-Epoch is honoured for a device exactly as for a session
    wrong = await dev.get("/api/tasks", headers={"Atlas-Sync": "1", "Atlas-Epoch": "other"})
    assert wrong.status_code == 409 and wrong.json()["error"] == "epoch_mismatch"


async def test_the_set_of_endpoints_open_to_devices_is_exactly_this() -> None:
    """Default deny: a route is closed to device tokens unless it uses ``SyncUser``. This list is
    the contract (SYNC_PROTOCOL.md 10.1); adding a route to it is a deliberate, reviewed change."""
    from atlas.api.deps import get_current_user, get_sync_user

    def calls(dependant: Any) -> set[Any]:
        found = {dependant.call}
        for sub in dependant.dependencies:
            found |= calls(sub)
        return found

    open_to_devices: set[tuple[str, str]] = set()
    browser_only: set[tuple[str, str]] = set()
    from atlas import api as api_package

    routes = [
        route
        for name in api_package.__all__
        for route in getattr(api_package, name).routes
        if isinstance(route, APIRoute)
    ]
    assert len(routes) > 60  # the walk found the application's routes
    for route in routes:
        used = calls(route.dependant)
        for method in route.methods - {"HEAD", "OPTIONS"}:
            if get_sync_user in used:
                open_to_devices.add((method, route.path))
            elif get_current_user in used:
                browser_only.add((method, route.path))
    assert {path.split("/")[2] for _m, path in open_to_devices} == {
        "auth",
        "calendar",
        "changes",
        "devices",
        "features",
        "folders",
        "instance",
        "notes",
        "projects",
        "reminders",
        "search",
        "sync",
        "tasks",
        "ttrpg",
    }
    # ADR-0084: devices may read the optional-feature switches (to show or hide a module) but
    # never change one; the module's own routes are open because it is user content, not account
    assert {(m, p) for m, p in open_to_devices if p.startswith("/api/features")} == {
        ("GET", "/api/features")
    }
    assert ("PUT", "/api/features/{feature}") in browser_only
    # M8-04a: the reminder actions (snooze/dismiss) and the list are the only reminder routes a
    # device may call; the timing preferences stay browser-only
    assert {p for _m, p in open_to_devices if p.startswith("/api/reminders")} == {
        "/api/reminders",
        "/api/reminders/{reminder_id}/actions",
    }
    # the desktop calendar page reads events: only the three read-only GETs are open
    assert {(m, p) for m, p in open_to_devices if p.startswith("/api/calendar")} == {
        ("GET", "/api/calendar/accounts"),
        ("GET", "/api/calendar/events"),
        ("GET", "/api/calendar/events/{event_id}"),
    }
    # the account-level surface is closed to devices
    for method, path in [
        ("POST", "/api/auth/password"),
        ("PATCH", "/api/auth/me"),
        ("POST", "/api/devices/revoke-all"),
        ("PATCH", "/api/devices/{device_id}"),
        ("DELETE", "/api/devices/{device_id}"),
        ("GET", "/api/export"),
    ]:
        assert (method, path) in browser_only, (method, path)
    assert not any(p.startswith(("/api/notifications", "/api/export")) for _m, p in open_to_devices)
    assert {
        ("GET", "/api/devices"),
        ("GET", "/api/devices/current"),
        ("POST", "/api/devices/current/rotate"),
        ("DELETE", "/api/devices/current"),
    } <= open_to_devices
    assert not any(p.startswith("/api/devices/{") for _m, p in open_to_devices)
    assert ("POST", "/api/devices/revoke-all") not in open_to_devices


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("POST", "/api/auth/password", {"current_password": PASSWORD, "new_password": "x" * 14}),
        ("PATCH", "/api/auth/me", {"display_name": "Mallory"}),
        ("GET", "/api/export", None),
        ("GET", "/api/calendar/credentials", None),
        ("GET", "/api/notifications/devices", None),
        ("POST", "/api/devices/revoke-all", None),
        ("PATCH", f"/api/devices/{uuid.uuid4()}", {"name": "x"}),
        ("DELETE", f"/api/devices/{uuid.uuid4()}", None),
    ],
)
async def test_a_device_cannot_use_account_level_endpoints(
    app: FastAPI, c, method: str, path: str, body: Any
) -> None:
    dev, _token, _ = await sign_in(app)
    r = await dev.request(method, path, json=body)
    assert r.status_code == 403, (path, r.status_code, r.text)
    assert r.json()["error"] == "forbidden_scope"
    # nothing changed
    me = await c.get("/api/auth/me")
    assert me.json()["display_name"] == "Owner"
    assert (
        await new_client(app).post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    ).status_code == 200


async def test_scope_is_checked_after_the_token_so_a_bad_token_is_still_a_401(
    app: FastAPI, c
) -> None:
    client = new_client(app)
    r = await client.post("/api/auth/password", headers=bearer("atd_" + "A" * 43), json={})
    assert r.status_code == 401 and r.json()["error"] == "unauthenticated"
    assert r.headers["www-authenticate"] == "Bearer"


# --- list, rename, revoke ----------------------------------------------------------------------


async def test_list_marks_the_current_device_and_hides_revoked_ones(app: FastAPI, c) -> None:
    a, _, a_dev = await sign_in(app, name="A")
    _b, _, b_dev = await sign_in(app, name="B", platform="android")
    browser = (await c.get("/api/devices")).json()["items"]
    assert [d["name"] for d in browser] == ["B", "A"]  # newest first
    assert not any(d["current"] for d in browser)  # a browser is not a device
    mine = (await a.get("/api/devices")).json()["items"]
    assert {d["name"]: d["current"] for d in mine} == {"A": True, "B": False}
    assert (await a.get("/api/devices/current")).json()["id"] == a_dev["id"]
    assert (await c.get("/api/devices/current")).status_code == 404  # a session is no device

    r = await c.delete(f"/api/devices/{b_dev['id']}", headers=csrf_headers(c))
    assert r.status_code == 204
    assert [d["name"] for d in (await c.get("/api/devices")).json()["items"]] == ["A"]
    everything = (await c.get("/api/devices", params={"include_revoked": True})).json()["items"]
    assert {d["name"]: d["revoked_at"] is not None for d in everything} == {"A": False, "B": True}


async def test_rename_trims_validates_and_is_user_scoped(app: FastAPI, c) -> None:
    _dev, _, device = await sign_in(app)
    r = await c.patch(
        f"/api/devices/{device['id']}", json={"name": "  Work   PC "}, headers=csrf_headers(c)
    )
    assert r.status_code == 200 and r.json()["name"] == "Work PC"
    for bad in ("", "  ", "x" * 81):
        r = await c.patch(
            f"/api/devices/{device['id']}", json={"name": bad}, headers=csrf_headers(c)
        )
        assert r.status_code == 422
    assert (
        await c.patch(f"/api/devices/{uuid.uuid4()}", json={"name": "x"}, headers=csrf_headers(c))
    ).status_code == 404
    # CSRF applies to the browser path
    assert (await c.patch(f"/api/devices/{device['id']}", json={"name": "x"})).status_code == 403


async def test_revoking_a_device_is_immediate_and_tells_the_holder(app: FastAPI, c) -> None:
    dev, token, device = await sign_in(app)
    assert (await dev.get("/api/tasks")).status_code == 200
    assert (await c.delete(f"/api/devices/{device['id']}")).status_code == 403  # CSRF
    r = await c.delete(f"/api/devices/{device['id']}", headers=csrf_headers(c))
    assert r.status_code == 204
    for request in (dev.get("/api/tasks"), dev.post("/api/tasks", json={"title": "x"})):
        r = await request
        assert r.status_code == 401
        assert r.json()["error"] == "token_revoked" and token not in r.text
    assert (await dev.get("/api/devices/current")).status_code == 401
    # revoking again is fine, revoking something that is not yours or does not exist is a 404
    again = await c.delete(f"/api/devices/{device['id']}", headers=csrf_headers(c))
    assert again.status_code == 204
    nothing = await c.delete(f"/api/devices/{uuid.uuid4()}", headers=csrf_headers(c))
    assert nothing.status_code == 404
    # the browser session is untouched
    assert (await c.get("/api/auth/me")).status_code == 200


async def test_revoke_all_signs_every_device_out_and_leaves_browsers_alone(app: FastAPI, c) -> None:
    a, _, _ = await sign_in(app, name="A")
    b, _, _ = await sign_in(app, name="B")
    r = await c.post("/api/devices/revoke-all", headers=csrf_headers(c))
    assert r.status_code == 200 and r.json() == {"revoked": 2}
    assert (await a.get("/api/tasks")).status_code == 401
    assert (await b.get("/api/tasks")).status_code == 401
    assert (await c.get("/api/auth/me")).status_code == 200
    assert (await c.post("/api/devices/revoke-all", headers=csrf_headers(c))).json() == {
        "revoked": 0
    }


async def test_a_device_can_sign_itself_out_and_nothing_else(app: FastAPI, c) -> None:
    a, token, _ = await sign_in(app, name="A")
    b, _, _ = await sign_in(app, name="B")
    assert (await a.delete("/api/devices/current")).status_code == 204
    r = await a.get("/api/tasks")
    assert r.status_code == 401 and r.json()["error"] == "token_revoked"
    assert (await b.get("/api/tasks")).status_code == 200
    assert token not in r.text


# --- rotation ----------------------------------------------------------------------------------


async def test_rotation_issues_a_new_token_and_the_old_one_works_for_a_grace_window(
    app: FastAPI, c
) -> None:
    dev, old, device = await sign_in(app)
    r = await dev.post("/api/devices/current/rotate")
    assert r.status_code == 200
    new = r.json()["token"]
    assert looks_like_device_token(new) and new != old and r.json()["device"]["id"] == device["id"]
    # lost response: the client still holds the old token, which keeps working
    assert (await new_client(app).get("/api/tasks", headers=bearer(old))).status_code == 200
    # once the new token is used, the old one is gone
    assert (await new_client(app).get("/api/tasks", headers=bearer(new))).status_code == 200
    gone = await new_client(app).get("/api/tasks", headers=bearer(old))
    assert gone.status_code == 401 and gone.json()["error"] == "unauthenticated"
    async with session_scope() as session:
        row = (await session.execute(select(Device))).scalar_one()
        assert row.prev_token_hash is None and row.token_hash == hash_device_token(new)


async def test_the_old_token_dies_when_the_grace_window_ends(app: FastAPI, c) -> None:
    dev, old, _ = await sign_in(app)
    new = (await dev.post("/api/devices/current/rotate")).json()["token"]
    async with session_scope() as session:
        await session.execute(
            update(Device).values(prev_valid_until=datetime.now(UTC) - timedelta(seconds=1))
        )
    assert (await new_client(app).get("/api/tasks", headers=bearer(old))).status_code == 401
    assert (await new_client(app).get("/api/tasks", headers=bearer(new))).status_code == 200


async def test_rotating_with_the_old_token_after_a_lost_response_recovers(app: FastAPI, c) -> None:
    dev, old, _ = await sign_in(app)
    lost = (await dev.post("/api/devices/current/rotate")).json()["token"]
    # the client never saw `lost`; it retries with the token it has
    retry = await new_client(app).post("/api/devices/current/rotate", headers=bearer(old))
    assert retry.status_code == 200
    fresh = retry.json()["token"]
    assert fresh not in (old, lost)
    # `lost` is the previous token now (valid for the window); `old` fell out of the chain
    assert (await new_client(app).get("/api/tasks", headers=bearer(lost))).status_code == 200
    assert (await new_client(app).get("/api/tasks", headers=bearer(old))).status_code == 401
    # using `fresh` ends the window of `lost`
    assert (await new_client(app).get("/api/tasks", headers=bearer(fresh))).status_code == 200
    assert (await new_client(app).get("/api/tasks", headers=bearer(lost))).status_code == 401


async def test_revoking_ends_the_grace_window_too(app: FastAPI, c) -> None:
    dev, old, device = await sign_in(app)
    await dev.post("/api/devices/current/rotate")
    await c.delete(f"/api/devices/{device['id']}", headers=csrf_headers(c))
    r = await new_client(app).get("/api/tasks", headers=bearer(old))
    assert r.status_code == 401  # revoked rows keep no previous hash: unknown, not usable


# --- idle expiry and last_seen ----------------------------------------------------------------


async def test_an_idle_device_must_sign_in_again(app: FastAPI, c) -> None:
    dev, _, _ = await sign_in(app)
    assert (await dev.get("/api/tasks")).status_code == 200
    async with session_scope() as session:
        await session.execute(
            update(Device).values(last_seen_at=datetime.now(UTC) - timedelta(days=91))
        )
    r = await dev.get("/api/tasks")
    assert r.status_code == 401 and r.json()["error"] == "token_expired"
    async with session_scope() as session:
        await session.execute(
            update(Device).values(last_seen_at=datetime.now(UTC) - timedelta(days=89))
        )
    assert (await dev.get("/api/tasks")).status_code == 200


async def test_a_device_that_never_made_a_request_expires_from_its_creation(
    app: FastAPI, c
) -> None:
    dev, _, _ = await sign_in(app)
    async with session_scope() as session:
        await session.execute(
            update(Device).values(created_at=datetime.now(UTC) - timedelta(days=100))
        )
    assert (await dev.get("/api/tasks")).json()["error"] == "token_expired"


async def _seen() -> datetime | None:
    async with session_scope() as session:
        return (await session.execute(select(Device.last_seen_at))).scalar_one()


async def test_last_seen_is_written_cheaply_and_by_the_server_clock(app: FastAPI, c) -> None:
    dev, _, _ = await sign_in(app)
    assert await _seen() is None
    # a forged client clock changes nothing: the value is the database's now()
    r = await dev.get("/api/tasks", headers={"Date": "Thu, 01 Jan 1970 00:00:00 GMT"})
    assert r.status_code == 200
    first = await _seen()
    assert first is not None and abs((datetime.now(UTC) - first).total_seconds()) < 60
    # a burst of requests does not write again within the interval
    async with session_scope() as session:
        stamp = datetime.now(UTC) - timedelta(seconds=30)
        await session.execute(update(Device).values(last_seen_at=stamp))
    for _ in range(5):
        await dev.get("/api/tasks")
    assert await _seen() == stamp
    # after the interval it is written again (even from another process: the row is the guard)
    reset_touch_cache()
    async with session_scope() as session:
        stamp = datetime.now(UTC) - timedelta(minutes=10)
        await session.execute(update(Device).values(last_seen_at=stamp))
    await dev.get("/api/tasks")
    later = await _seen()
    assert later is not None and later > stamp + timedelta(minutes=9)


async def test_a_failing_request_still_records_the_sighting_and_a_revoked_device_does_not(
    app: FastAPI, c
) -> None:
    dev, _, device = await sign_in(app)
    assert (await dev.get(f"/api/tasks/{uuid.uuid4()}")).status_code == 404
    assert await _seen() is not None
    await c.delete(f"/api/devices/{device['id']}", headers=csrf_headers(c))
    async with session_scope() as session:
        await session.execute(update(Device).values(last_seen_at=None))
    reset_touch_cache()
    assert (await dev.get("/api/tasks")).status_code == 401
    assert await _seen() is None


# --- rate limits -------------------------------------------------------------------------------


async def test_devices_are_rate_limited_per_device_not_per_address(
    app: FastAPI, c, monkeypatch
) -> None:
    from atlas.api import deps
    from atlas.auth.ratelimit import RateLimiter

    monkeypatch.setattr(deps, "device_request_limiter", RateLimiter(limit=5, per_seconds=60))
    monkeypatch.setattr(deps, "device_write_limiter", RateLimiter(limit=2, per_seconds=60))
    a, _, _ = await sign_in(app, name="A")
    b, _, _ = await sign_in(app, name="B")
    writes = [
        (await a.post("/api/tasks", json={"title": "t"}, headers=sync_headers())).status_code
        for _ in range(3)
    ]
    assert writes == [201, 201, 429]
    limited = await a.post("/api/tasks", json={"title": "t"}, headers=sync_headers())
    assert limited.status_code == 429 and limited.json()["error"] == "rate_limited"
    assert int(limited.headers["retry-after"]) >= 1
    # another device on the same address is unaffected, the browser too
    assert (
        await b.post("/api/tasks", json={"title": "t"}, headers=sync_headers())
    ).status_code == 201
    assert (await c.get("/api/tasks")).status_code == 200


# --- password change / reset -------------------------------------------------------------------


async def test_a_password_change_keeps_devices_unless_asked(app: FastAPI, c) -> None:
    dev, _, _ = await sign_in(app)
    r = await c.post(
        "/api/auth/password",
        json={"current_password": PASSWORD, "new_password": "second password 123"},
        headers=csrf_headers(c),
    )
    assert r.status_code == 204
    assert (await dev.get("/api/tasks")).status_code == 200
    r = await c.post(
        "/api/auth/password",
        json={
            "current_password": "second password 123",
            "new_password": "third password 1234",
            "revoke_devices": True,
        },
        headers=csrf_headers(c),
    )
    assert r.status_code == 204
    assert (await dev.get("/api/tasks")).json()["error"] == "token_revoked"
    assert (await c.get("/api/auth/me")).status_code == 200  # this browser got a fresh session


async def test_a_wrong_current_password_revokes_nothing(app: FastAPI, c) -> None:
    dev, _, _ = await sign_in(app)
    r = await c.post(
        "/api/auth/password",
        json={"current_password": "wrong", "new_password": "x" * 14, "revoke_devices": True},
        headers=csrf_headers(c),
    )
    assert r.status_code == 400
    assert (await dev.get("/api/tasks")).status_code == 200


async def test_the_operator_reset_revokes_every_device_token(app: FastAPI, c) -> None:
    from atlas.auth.cli import list_devices, reset_password, revoke_devices

    a, _, _ = await sign_in(app, name="A")
    b, _, _ = await sign_in(app, name="B")
    async with session_scope() as session:
        sessions, devices = await reset_password(session, EMAIL, "operator chosen password")
    assert sessions >= 1 and devices == 2
    assert (await a.get("/api/tasks")).json()["error"] == "token_revoked"
    assert (await b.get("/api/tasks")).status_code == 401
    # the old password no longer signs a device in, the new one does
    old = await new_client(app).post(
        "/api/devices", json={"email": EMAIL, "password": PASSWORD, "name": "x"}
    )
    assert old.status_code == 401
    fresh = await new_client(app).post(
        "/api/devices", json={"email": EMAIL, "password": "operator chosen password", "name": "x"}
    )
    assert fresh.status_code == 201
    # the operator can list and revoke devices
    async with session_scope() as session:
        rows = await list_devices(session, EMAIL)
        assert [d.revoked_at is None for d in rows] == [False, False, True]
        assert await revoke_devices(session, EMAIL, device_id=None, everything=True) == 1
        from atlas.auth.cli import ResetError

        with pytest.raises(ResetError):
            await revoke_devices(session, EMAIL, device_id=uuid.uuid4(), everything=False)
        with pytest.raises(ResetError):
            await list_devices(session, "nobody@example.com")
    assert (
        await new_client(app).get("/api/tasks", headers=bearer(fresh.json()["token"]))
    ).status_code == 401


# --- device_id in the resolution log ------------------------------------------------------------


async def test_the_resolution_log_names_the_device_that_wrote(app: FastAPI, c) -> None:
    a, _, a_dev = await sign_in(app, name="A")
    b, _, b_dev = await sign_in(app, name="B")
    task = (await a.post("/api/tasks", json={"title": "t"}, headers=sync_headers())).json()
    first = await a.patch(
        f"/api/tasks/{task['id']}",
        json={"base_revision": 1, "priority": "low"},
        headers=sync_headers(),
    )
    assert first.status_code == 200 and first.json()["sync"]["resolution"] == []
    second = await b.patch(
        f"/api/tasks/{task['id']}",
        json={"base_revision": 1, "priority": "high"},
        headers=sync_headers(),
    )
    [res] = second.json()["sync"]["resolution"]
    listed = (await a.get("/api/sync/resolutions", headers={"Atlas-Sync": "1"})).json()[
        "resolutions"
    ]
    assert [r["device_id"] for r in listed] == [b_dev["id"]]
    assert listed[0]["id"] == res["id"]
    # the feed carries the same device_id, so A can tell "changed on another device"
    feed = (
        await a.get(
            "/api/changes",
            params={"since": 0, "include": "data", "types": "resolution"},
            headers={"Atlas-Sync": "1"},
        )
    ).json()
    [item] = [i for i in feed["changes"] if i["entity_type"] == "resolution"]
    assert item["data"]["device_id"] == b_dev["id"] != a_dev["id"]
    # undo by A: the undo entry is A's, the original stays B's
    undone = await a.post(
        f"/api/sync/resolutions/{res['id']}/undo",
        headers=sync_headers(),
    )
    assert undone.status_code == 200, undone.text
    assert undone.json()["undo"]["device_id"] == a_dev["id"]
    assert undone.json()["resolution"]["device_id"] == b_dev["id"]


async def test_a_browser_session_write_has_no_device(app: FastAPI, c) -> None:
    dev, _, _ = await sign_in(app)
    task = (
        await c.post("/api/tasks", json={"title": "t"}, headers=sync_headers(csrf_headers(c)))
    ).json()
    await dev.patch(
        f"/api/tasks/{task['id']}",
        json={"base_revision": 1, "priority": "low"},
        headers=sync_headers(),
    )
    r = await c.patch(
        f"/api/tasks/{task['id']}",
        json={"base_revision": 1, "priority": "high"},
        headers=sync_headers(csrf_headers(c)),
    )
    assert r.status_code == 200 and len(r.json()["sync"]["resolution"]) == 1
    listed = (await c.get("/api/sync/resolutions", headers={"Atlas-Sync": "1"})).json()[
        "resolutions"
    ]
    assert [x["device_id"] for x in listed] == [None]


async def test_purging_a_device_keeps_its_resolutions(app: FastAPI, c) -> None:
    dev, _, device = await sign_in(app)
    task = (
        await c.post("/api/tasks", json={"title": "t"}, headers=sync_headers(csrf_headers(c)))
    ).json()
    await c.patch(
        f"/api/tasks/{task['id']}",
        json={"base_revision": 1, "priority": "low"},
        headers=sync_headers(csrf_headers(c)),
    )
    await dev.patch(
        f"/api/tasks/{task['id']}",
        json={"base_revision": 1, "priority": "high"},
        headers=sync_headers(),
    )
    async with session_scope() as session:
        assert (
            await session.execute(
                text("SELECT count(*) FROM sync_resolutions WHERE device_id IS NOT NULL")
            )
        ).scalar_one() == 1
        await session.execute(text("DELETE FROM devices"))
        assert (
            await session.execute(
                text("SELECT count(*) FROM sync_resolutions WHERE device_id IS NULL")
            )
        ).scalar_one() == 1
    assert device


async def test_the_purge_job_deletes_old_revoked_devices_only(app: FastAPI, c) -> None:
    from atlas.auth.devices import purge_revoked_devices

    _a, _, old = await sign_in(app, name="old revoked")
    _b, _, recent = await sign_in(app, name="recent revoked")
    _c, _, idle = await sign_in(app, name="idle but never revoked")
    _d, _, live = await sign_in(app, name="live")
    async with session_scope() as session:
        now = datetime.now(UTC)
        for name, revoked in (
            ("old revoked", now - timedelta(days=100)),
            ("recent revoked", now - timedelta(days=1)),
        ):
            await session.execute(
                update(Device).where(Device.name == name).values(revoked_at=revoked)
            )
        await session.execute(
            update(Device)
            .where(Device.name == "idle but never revoked")
            .values(last_seen_at=now - timedelta(days=400))
        )
    async with session_scope() as session:
        cutoff = datetime.now(UTC) - timedelta(days=90)
        assert await purge_revoked_devices(session, cutoff=cutoff) == 1
        assert await purge_revoked_devices(session, cutoff=cutoff) == 0  # repeatable
    async with session_scope() as session:
        left = set((await session.execute(select(Device.name))).scalars())
    assert left == {"recent revoked", "idle but never revoked", "live"}
    assert old and recent and idle and live


async def test_a_burst_of_parallel_requests_costs_one_bookkeeping_write(
    app: FastAPI, c, monkeypatch
) -> None:
    """Every request already holds a pooled connection; twenty parallel requests of one device must
    not each open a second one for `last_seen_at` (that could starve the pool)."""
    import asyncio

    from atlas.auth import devices as devices_module

    dev, _, _ = await sign_in(app)
    calls = 0
    real = devices_module.get_session_factory

    def counting() -> Any:
        nonlocal calls
        calls += 1
        return real()

    monkeypatch.setattr(devices_module, "get_session_factory", counting)
    results = await asyncio.gather(*(dev.get("/api/tasks") for _ in range(20)))
    assert {r.status_code for r in results} == {200}
    assert calls == 1
    assert await _seen() is not None
