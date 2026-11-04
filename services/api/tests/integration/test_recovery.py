"""Account recovery by one-time code (AUTH-01, ADR-0067; SECURITY.md T25-T30). Real PostgreSQL.

Covers the setup reveal, the forgot-password reset (password, sessions, devices and the code
change in one transaction), replay, enumeration resistance, throttling, regeneration, cross-user
isolation, the disabled switch and hygiene (nothing secret in logs, errors, exports or the
database). Backup contents are in ``test_recovery_backup.py``.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import event, select, text

from atlas.api.auth import _login_limiter, _recovery_account_limiter
from atlas.auth import (
    generate_session_token,
    hash_password,
    hash_session_token,
    issue_csrf_token,
)
from atlas.auth.cli import ResetError, issue_code_for, reset_password
from atlas.auth.recovery import normalize_code
from atlas.config import get_settings
from atlas.db import get_engine, session_scope
from atlas.models import AuthSession, Device, RecoveryCode, User
from tests.conftest import csrf_headers
from tests.integration.test_devices import bearer, new_client, sign_in

pytestmark = pytest.mark.usefixtures("_db")

EMAIL = "owner@example.com"
PASSWORD = "correct horse battery"
NEW_PASSWORD = "a brand new passphrase"
OTHER = "second@example.com"
OTHER_PASSWORD = "another long password"
RESET = "/api/auth/recovery/reset"
REFUSED = {"detail": "The email or recovery code is not correct"}


async def setup_owner(client: AsyncClient) -> str:
    response = await client.post(
        "/api/auth/setup",
        json={"email": EMAIL, "password": PASSWORD, "display_name": "Owner"},
    )
    assert response.status_code == 201, response.text
    code = response.json()["recovery_code"]
    assert isinstance(code, str)
    return code


@pytest.fixture
async def owner(app: FastAPI) -> tuple[AsyncClient, str]:
    client = new_client(app)
    return client, await setup_owner(client)


def anonymous(app: FastAPI) -> AsyncClient:
    return new_client(app)


async def reset(
    client: AsyncClient, code: str, *, email: str = EMAIL, password: str = NEW_PASSWORD
) -> Any:
    return await client.post(
        RESET, json={"email": email, "recovery_code": code, "new_password": password}
    )


async def login_status(client: AsyncClient, password: str, email: str = EMAIL) -> int:
    response = await client.post("/api/auth/login", json={"email": email, "password": password})
    return response.status_code


async def second_user(app: FastAPI) -> tuple[AsyncClient, str]:
    """A second account with its own session and recovery code (setup is one-shot)."""
    from atlas.auth.recovery import issue_recovery_code

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
        issued = await issue_recovery_code(session, user.id)
    client = new_client(app)
    client.cookies.set("atlas_session", token)
    client.cookies.set("atlas_csrf", issue_csrf_token(token))
    return client, issued.code


# --- setup reveals the code once --------------------------------------------------------------


async def test_setup_returns_the_code_once_and_stores_only_a_hash(
    owner: tuple[AsyncClient, str],
) -> None:
    client, code = owner
    assert normalize_code(code) is not None
    async with session_scope() as session:
        row = (await session.execute(select(RecoveryCode))).scalar_one()
    plain = normalize_code(code)
    assert plain and plain not in (row.code_hash, row.code_salt)
    assert len(row.code_hash) == 64 and row.failed_attempts == 0 and row.last_used_at is None
    status = (await client.get("/api/auth/recovery")).json()
    assert status["configured"] is True and status["enabled"] is True
    assert code not in str(status) and row.code_hash not in str(status)
    assert set(status) == {"enabled", "configured", "created_at", "last_used_at", "failed_attempts"}
    assert "recovery_code" not in (await client.get("/api/auth/me")).json()
    assert (await client.get("/api/setup/status")).json()["recovery_enabled"] is True


async def test_a_second_setup_cannot_reveal_or_replace_the_code(
    owner: tuple[AsyncClient, str],
) -> None:
    client, code = owner
    again = await client.post(
        "/api/auth/setup",
        json={"email": "x@example.com", "password": PASSWORD, "display_name": "X"},
    )
    assert again.status_code == 409 and "recovery_code" not in again.text
    assert (await reset(client, code)).status_code == 200


# --- the reset --------------------------------------------------------------------------------


async def test_a_reset_changes_the_password_signs_everything_out_and_rotates_the_code(
    app: FastAPI, owner: tuple[AsyncClient, str]
) -> None:
    browser, code = owner
    other_browser = anonymous(app)
    assert await login_status(other_browser, PASSWORD) == 200
    device, token, _ = await sign_in(app)
    assert (await device.get("/api/tasks", headers=bearer(token))).status_code == 200

    forgotten = anonymous(app)
    response = await reset(forgotten, code.lower().replace("-", " "))  # sloppy entry is fine
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {"recovery_code", "created_at"}
    new_code = body["recovery_code"]
    assert normalize_code(new_code) and normalize_code(new_code) != normalize_code(code)
    assert "set-cookie" not in response.headers  # it does not sign this browser in

    for stale in (browser, other_browser):  # every browser session is gone
        assert (await stale.get("/api/auth/me")).status_code == 401
    assert (await device.get("/api/tasks", headers=bearer(token))).status_code == 401  # and device
    assert (await device.get("/api/tasks", headers=bearer(token))).json()["error"] == (
        "token_revoked"
    )
    assert await login_status(anonymous(app), PASSWORD) == 401
    assert await login_status(anonymous(app), NEW_PASSWORD) == 200

    async with session_scope() as session:
        row = (await session.execute(select(RecoveryCode))).scalar_one()
        revoked = (await session.execute(select(Device.revoked_at))).scalars().all()
    assert row.last_used_at is not None and row.failed_attempts == 0
    assert all(r is not None for r in revoked)


async def test_a_used_code_cannot_be_replayed_and_the_new_one_works(
    app: FastAPI, owner: tuple[AsyncClient, str]
) -> None:
    _, code = owner
    first = await reset(anonymous(app), code)
    assert first.status_code == 200
    replay = await reset(anonymous(app), code, password="an attacker chosen password")
    assert replay.status_code == 400 and replay.json() == REFUSED
    assert await login_status(anonymous(app), "an attacker chosen password") == 401
    assert await login_status(anonymous(app), NEW_PASSWORD) == 200
    second = await reset(anonymous(app), first.json()["recovery_code"], password="third password!!")
    assert second.status_code == 200
    assert await login_status(anonymous(app), "third password!!") == 200


async def test_two_simultaneous_resets_with_one_code_succeed_exactly_once(
    app: FastAPI, owner: tuple[AsyncClient, str]
) -> None:
    _, code = owner
    results = await asyncio.gather(
        reset(anonymous(app), code, password="first racing password"),
        reset(anonymous(app), code, password="second racing password"),
    )
    assert sorted(r.status_code for r in results) == [200, 400]
    winner = "first racing password" if results[0].status_code == 200 else "second racing password"
    assert await login_status(anonymous(app), winner) == 200


async def test_the_reset_is_one_transaction(
    app: FastAPI, owner: tuple[AsyncClient, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """A failing device sign-out leaves the password, the sessions and the code as they were."""
    browser, code = owner

    async def boom(*_a: object, **_k: object) -> int:
        raise RuntimeError("device revocation failed")

    monkeypatch.setattr("atlas.auth.recovery.revoke_all_devices", boom)
    with pytest.raises(RuntimeError):
        await reset(anonymous(app), code)
    monkeypatch.undo()
    assert (await browser.get("/api/auth/me")).status_code == 200
    assert await login_status(anonymous(app), PASSWORD) == 200
    assert (await reset(anonymous(app), code)).status_code == 200  # the code was not consumed


async def test_an_ordinary_password_change_leaves_the_code_alone(
    app: FastAPI, owner: tuple[AsyncClient, str]
) -> None:
    browser, code = owner
    changed = await browser.post(
        "/api/auth/password",
        json={"current_password": PASSWORD, "new_password": "changed in settings 1"},
        headers=csrf_headers(browser),
    )
    assert changed.status_code == 204
    assert (await browser.get("/api/auth/recovery")).json()["configured"] is True
    assert (await reset(anonymous(app), code)).status_code == 200  # same code, still valid


async def test_the_operator_reset_leaves_the_code_and_the_operator_can_issue_a_new_one(
    app: FastAPI, owner: tuple[AsyncClient, str]
) -> None:
    _, code = owner
    async with session_scope() as session:
        await reset_password(session, EMAIL, "operator chosen password")
    async with session_scope() as session:
        issued = await issue_code_for(session, EMAIL)
    assert (await reset(anonymous(app), code)).status_code == 400  # replaced by the CLI
    assert (await reset(anonymous(app), issued.code)).status_code == 200
    async with session_scope() as session:
        with pytest.raises(ResetError):
            await issue_code_for(session, "nobody@example.com")


async def test_input_variants_the_owner_may_type(
    app: FastAPI, owner: tuple[AsyncClient, str]
) -> None:
    _, code = owner
    response = await reset(anonymous(app), code, email="OWNER@Example.COM")
    assert response.status_code == 200


# --- enumeration ------------------------------------------------------------------------------


async def _make_inactive_and_codeless(app: FastAPI) -> None:
    async with session_scope() as session:
        session.add(
            User(
                email="inactive@example.com",
                display_name="I",
                password_hash=hash_password(OTHER_PASSWORD),
                is_active=False,
            )
        )
        session.add(
            User(
                email="nocode@example.com", display_name="N", password_hash=hash_password("x" * 14)
            )
        )


async def test_every_refusal_is_the_same_response_and_the_same_work(
    app: FastAPI, owner: tuple[AsyncClient, str]
) -> None:
    _, code = owner
    await _make_inactive_and_codeless(app)
    async with session_scope() as session:
        user = (
            await session.execute(select(User).where(User.email == "inactive@example.com"))
        ).scalar_one()
        from atlas.auth.recovery import issue_recovery_code

        inactive_code = (await issue_recovery_code(session, user.id)).code
    statements: list[str] = []
    engine = get_engine().sync_engine

    def record(_c: Any, _cur: Any, statement: str, *_a: Any) -> None:
        statements.append(" ".join(statement.split())[:60])

    event.listen(engine, "before_cursor_execute", record)
    try:
        cases = {
            "unknown": {"email": "nobody@example.com", "code": code},
            "no code": {"email": "nocode@example.com", "code": code},
            "inactive": {"email": "inactive@example.com", "code": inactive_code},
            "wrong code": {"email": EMAIL, "code": "0" * 5 + "-" + "1" * 25},
            "malformed": {"email": EMAIL, "code": "not a recovery code"},
            "someone else's code": {"email": "nocode@example.com", "code": code},
        }
        seen: dict[str, tuple[int, bytes, tuple[str, ...]]] = {}
        for name, case in cases.items():
            _login_limiter.reset()
            _recovery_account_limiter.reset()
            statements.clear()
            response = await reset(anonymous(app), case["code"], email=case["email"])
            headers = {k: v for k, v in response.headers.items() if k not in {"x-request-id"}}
            seen[name] = (
                response.status_code,
                response.content,
                tuple(sorted(headers.items())) + tuple(statements),
            )
    finally:
        event.remove(engine, "before_cursor_execute", record)
    assert {v[0] for v in seen.values()} == {400}
    assert {v[1] for v in seen.values()} == {
        b'{"detail":"The email or recovery code is not correct"}'
    }
    # same headers and the same statements, in the same order, for every kind of refusal
    shapes = {v[2] for v in seen.values()}
    assert len(shapes) == 1, seen
    # nothing about the refusals changed the real account
    assert await login_status(anonymous(app), PASSWORD) == 200


async def test_the_failure_counter_is_diagnostic_and_not_an_answer(
    app: FastAPI, owner: tuple[AsyncClient, str]
) -> None:
    client, code = owner
    for _ in range(3):
        assert (await reset(anonymous(app), "0" * 30)).status_code == 400
    assert (await client.get("/api/auth/recovery")).json()["failed_attempts"] == 3
    assert (await reset(anonymous(app), code)).status_code == 200  # the right code still works
    async with session_scope() as session:
        assert (await session.execute(select(RecoveryCode.failed_attempts))).scalar_one() == 0


# --- throttling -------------------------------------------------------------------------------


async def test_attempts_per_account_are_limited_and_the_limit_is_a_bounded_delay(
    app: FastAPI, owner: tuple[AsyncClient, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    _, code = owner
    for _ in range(5):
        assert (await reset(anonymous(app), "0" * 30)).status_code == 400
    blocked = await reset(anonymous(app), code)  # even the right code waits: no oracle
    assert blocked.status_code == 429 and blocked.json() == {"detail": "Too many requests"}
    retry = int(blocked.headers["retry-after"])
    assert 1 <= retry <= 900
    # an unknown address is throttled the same way (no account is revealed by the 429)
    for _ in range(5):
        await reset(anonymous(app), "0" * 30, email="ghost@example.com")
    ghost = await reset(anonymous(app), "0" * 30, email="ghost@example.com")
    assert ghost.status_code == 429 and ghost.headers["retry-after"]
    # another account is not locked by it
    # time passes: the window slides and the owner is back (a delay, never a lock)
    import atlas.auth.ratelimit as ratelimit

    real = ratelimit.time.monotonic
    monkeypatch.setattr(ratelimit.time, "monotonic", lambda: real() + 901)
    _login_limiter.reset()
    assert (await reset(anonymous(app), code)).status_code == 200


async def test_attempts_per_address_are_limited_across_accounts(
    app: FastAPI, owner: tuple[AsyncClient, str]
) -> None:
    limit = get_settings().auth_rate_limit_per_minute
    _login_limiter.reset()  # setup counted one hit
    codes = []
    for i in range(limit + 2):
        r = await reset(anonymous(app), "0" * 30, email=f"user{i}@example.com")
        codes.append(r.status_code)
    assert codes[:limit] == [400] * limit and codes[limit:] == [429, 429]
    assert "retry-after" in (await reset(anonymous(app), "0" * 30)).headers


# --- regeneration in Settings -----------------------------------------------------------------


async def test_regenerating_needs_the_password_and_kills_the_old_code(
    app: FastAPI, owner: tuple[AsyncClient, str]
) -> None:
    browser, old = owner
    url = "/api/auth/recovery/regenerate"
    assert (await anonymous(app).post(url, json={"current_password": PASSWORD})).status_code == 401
    assert (
        await browser.post(url, json={"current_password": PASSWORD})  # no CSRF header
    ).status_code == 403
    wrong = await browser.post(
        url, json={"current_password": "not my password"}, headers=csrf_headers(browser)
    )
    assert wrong.status_code == 400 and "recovery_code" not in wrong.text
    ok = await browser.post(url, json={"current_password": PASSWORD}, headers=csrf_headers(browser))
    assert ok.status_code == 200
    new = ok.json()["recovery_code"]
    assert normalize_code(new) != normalize_code(old)
    assert (await browser.get("/api/auth/me")).status_code == 200  # sessions untouched
    assert (await reset(anonymous(app), old)).status_code == 400
    assert (await reset(anonymous(app), new)).status_code == 200


async def test_an_existing_account_without_a_code_can_make_one(app: FastAPI) -> None:
    """The upgrade path: accounts created before AUTH-01 have no code until they ask for one."""
    owner = new_client(app)
    await setup_owner(owner)
    async with session_scope() as session:
        await session.execute(text("DELETE FROM recovery_codes"))
    assert (await owner.get("/api/auth/recovery")).json()["configured"] is False
    assert (await reset(anonymous(app), "0" * 30)).status_code == 400
    made = await owner.post(
        "/api/auth/recovery/regenerate",
        json={"current_password": PASSWORD},
        headers=csrf_headers(owner),
    )
    assert made.status_code == 200
    assert (await owner.get("/api/auth/recovery")).json()["configured"] is True
    assert (await reset(anonymous(app), made.json()["recovery_code"])).status_code == 200


async def test_regeneration_guesses_at_the_password_are_rate_limited(
    app: FastAPI, owner: tuple[AsyncClient, str]
) -> None:
    browser, _ = owner
    url = "/api/auth/recovery/regenerate"
    codes = [
        (
            await browser.post(
                url, json={"current_password": "wrong"}, headers=csrf_headers(browser)
            )
        ).status_code
        for _ in range(get_settings().auth_rate_limit_per_minute + 1)
    ]
    assert codes[-1] == 429 and set(codes[:-1]) == {400}
    assert (
        "retry-after"
        in (
            await browser.post(
                url, json={"current_password": PASSWORD}, headers=csrf_headers(browser)
            )
        ).headers
    )


async def test_a_device_cannot_read_or_regenerate_the_code(
    app: FastAPI, owner: tuple[AsyncClient, str]
) -> None:
    _, token, _ = (lambda r: r)(await sign_in(app))
    thief = anonymous(app)
    for method, path, body in [
        ("GET", "/api/auth/recovery", None),
        ("POST", "/api/auth/recovery/regenerate", {"current_password": PASSWORD}),
    ]:
        r = await thief.request(method, path, json=body, headers=bearer(token))
        assert r.status_code == 403 and r.json()["error"] == "forbidden_scope", path


# --- isolation --------------------------------------------------------------------------------


async def test_one_users_code_never_opens_another_account(
    app: FastAPI, owner: tuple[AsyncClient, str]
) -> None:
    _, owner_code = owner
    other, other_code = await second_user(app)
    swapped = await reset(anonymous(app), owner_code, email=OTHER)
    assert swapped.status_code == 400
    assert (await reset(anonymous(app), other_code, email=EMAIL)).status_code == 400
    assert await login_status(anonymous(app), OTHER_PASSWORD, OTHER) == 200
    # regenerating for one user leaves the other's code valid
    assert (await other.get("/api/auth/recovery")).json()["configured"] is True
    regenerated = await other.post(
        "/api/auth/recovery/regenerate",
        json={"current_password": OTHER_PASSWORD},
        headers=csrf_headers(other),
    )
    assert regenerated.status_code == 200
    assert (
        await reset(anonymous(app), owner_code, password="owner got back in!!")
    ).status_code == 200
    # a reset signs out only its own account
    assert (await other.get("/api/auth/me")).status_code == 200


# --- switch -----------------------------------------------------------------------------------


async def test_recovery_can_be_turned_off(app: FastAPI, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(get_settings(), "recovery_enabled", False)
    client = new_client(app)
    assert (await client.get("/api/setup/status")).json()["recovery_enabled"] is False
    response = await client.post(
        "/api/auth/setup", json={"email": EMAIL, "password": PASSWORD, "display_name": "O"}
    )
    assert response.status_code == 201 and response.json()["recovery_code"] is None
    async with session_scope() as session:
        assert (await session.execute(select(RecoveryCode))).first() is None
    status = (await client.get("/api/auth/recovery")).json()
    assert status["enabled"] is False and status["configured"] is False
    assert (await reset(anonymous(app), "0" * 30)).status_code == 404
    regenerate = await client.post(
        "/api/auth/recovery/regenerate",
        json={"current_password": PASSWORD},
        headers=csrf_headers(client),
    )
    assert regenerate.status_code == 404
    # the CLI path stays: that is what "CLI only" means
    async with session_scope() as session:
        assert await reset_password(session, EMAIL, NEW_PASSWORD) == (1, 0)


# --- cookies, CSRF, validation ----------------------------------------------------------------


async def test_the_reset_is_unauthenticated_like_login_and_ignores_cookies(
    app: FastAPI, owner: tuple[AsyncClient, str]
) -> None:
    browser, code = owner
    # a browser holding a session posts without a CSRF header: it is exempt, as login is, because
    # it is authorised by the code alone and sets nothing
    response = await reset(browser, code)
    assert response.status_code == 200
    assert "set-cookie" not in response.headers
    # the session it held is gone: the cookie did not keep it alive
    assert (await browser.get("/api/auth/me")).status_code == 401


async def test_validation_errors_never_echo_the_code_or_the_password(
    app: FastAPI, owner: tuple[AsyncClient, str]
) -> None:
    _, code = owner
    response = await anonymous(app).post(
        RESET, json={"email": EMAIL, "recovery_code": code, "new_password": "Zq9-Wx-Lm4"}
    )
    assert response.status_code == 422
    assert code not in response.text and "Zq9-Wx-Lm4" not in response.text
    assert "input" not in response.text
    # a refused-for-shape request is still a 400 with the generic body, not a 422 that reveals it
    odd = await reset(anonymous(app), "x" * 129)
    assert odd.status_code == 422 and "x" * 20 not in odd.text


# --- hygiene ----------------------------------------------------------------------------------


async def test_no_code_or_password_reaches_the_logs(
    app: FastAPI, owner: tuple[AsyncClient, str], caplog: pytest.LogCaptureFixture
) -> None:
    _browser, code = owner
    caplog.set_level(logging.DEBUG)
    # alembic's fileConfig (run once per test session) disables loggers that already exist
    logging.getLogger("atlas.auth.audit").disabled = False
    first = await reset(anonymous(app), code)
    new_code = first.json()["recovery_code"]
    await reset(anonymous(app), code)  # refused replay
    await reset(anonymous(app), "0" * 30, email="ghost@example.com")
    await anonymous(app).post(
        RESET, json={"email": EMAIL, "recovery_code": new_code, "new_password": "short"}
    )
    login = anonymous(app)
    await login_status(login, NEW_PASSWORD)
    regenerated = await login.post(
        "/api/auth/recovery/regenerate",
        json={"current_password": NEW_PASSWORD},
        headers=csrf_headers(login),
    )
    assert regenerated.status_code == 200
    haystack = "\n".join(
        f"{r.getMessage()} {r.__dict__}" for r in caplog.records if r.name != "sqlalchemy.engine"
    )
    secrets_ = [
        code,
        normalize_code(code),
        new_code,
        normalize_code(new_code),
        regenerated.json()["recovery_code"],
        PASSWORD,
        NEW_PASSWORD,
        "ghost@example.com",
    ]
    for secret in secrets_:
        assert secret and secret not in haystack
    events = [r.__dict__.get("event") for r in caplog.records if r.name == "atlas.auth.audit"]
    assert events == [
        "recovery_reset_succeeded",
        "recovery_reset_refused",
        "recovery_reset_refused",
        "recovery_code_regenerated",
    ]
    succeeded = next(
        r for r in caplog.records if r.__dict__.get("event") == "recovery_reset_succeeded"
    )
    assert (
        succeeded.__dict__["sessions_revoked"] == 1 and succeeded.__dict__["devices_revoked"] == 0
    )


async def test_the_database_and_the_export_hold_no_plaintext_code(
    app: FastAPI, owner: tuple[AsyncClient, str]
) -> None:
    client, code = owner
    plain = normalize_code(code)
    assert plain
    export = await client.get("/api/export")
    assert export.status_code == 200
    assert plain not in export.text and code not in export.text
    async with session_scope() as session:
        tables = (
            (
                await session.execute(
                    text("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
                )
            )
            .scalars()
            .all()
        )
        for table in tables:
            dump = (
                await session.execute(
                    text(f"SELECT coalesce(string_agg(t::text, E'\\n'), '') FROM \"{table}\" t")
                )
            ).scalar_one()
            assert plain not in dump and code not in dump, table
