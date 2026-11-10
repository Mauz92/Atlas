"""OAuth connect/callback/disconnect over HTTP against PostgreSQL and the fake provider (M5-03/04/05).

The "browser" is played by the test: it GETs the provider's authorisation URL on the in-process fake
(which auto-approves and redirects) and then GETs the redirect target on Atlas with the session
cookie. No real provider, account or network is involved (AGENTS.md §11).
"""

from __future__ import annotations

import logging
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from sqlalchemy import select, text

from atlas.config import get_settings
from atlas.db import session_scope
from atlas.models import CalendarSource, ExternalEvent, ProviderCredential
from tests.conftest import create_user_via_setup, csrf_headers
from tests.fakes.calendar_provider import PROVIDER, build_app

pytestmark = pytest.mark.usefixtures("_db")


async def _login(client) -> dict[str, str]:
    await create_user_via_setup(client)
    return csrf_headers(client)


async def _browser(url: str) -> httpx.Response:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=build_app())) as browser:
        return await browser.get(url)


async def _start(client, headers, provider: str) -> str:
    response = await client.post(f"/api/calendar/accounts/{provider}/connect", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["authorization_url"]


async def _connect(client, headers, provider: str = "google") -> httpx.Response:
    """Run the whole flow; returns the callback response (a redirect to Settings)."""
    authorization_url = await _start(client, headers, provider)
    redirect = await _browser(authorization_url)
    assert redirect.status_code == 302
    target = urlsplit(redirect.headers["location"])
    return await client.get(f"{target.path}?{target.query}")


def _result(response: httpx.Response) -> dict[str, str]:
    assert response.status_code == 303
    query = parse_qs(urlsplit(response.headers["location"]).query)
    assert urlsplit(response.headers["location"]).path == "/settings/calendar"
    return {k: v[0] for k, v in query.items()}


async def test_unconfigured_providers_report_setup_problems_and_refuse_to_connect(
    client, monkeypatch
) -> None:
    headers = await _login(client)
    settings = get_settings()
    for name in (
        "google_client_id",
        "google_client_secret",
        "microsoft_client_id",
        "microsoft_client_secret",
    ):
        monkeypatch.setattr(settings, name, "")
    cards = {
        c["provider"]: c for c in (await client.get("/api/calendar/accounts")).json()["providers"]
    }
    assert cards["google"]["configured"] is False
    assert set(cards["google"]["setup_problems"]) >= {"client_id_missing", "client_secret_missing"}
    assert cards["ics"]["configured"] is True and not cards["ics"]["connected"]
    refused = await client.post("/api/calendar/accounts/google/connect", headers=headers)
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "not_configured"


async def test_the_redirect_uri_is_built_from_public_base_url_and_validated(
    client, fake_provider, monkeypatch
) -> None:
    headers = await _login(client)
    settings = get_settings()
    monkeypatch.setattr(settings, "public_base_url", "https://galaxia-atlas.duckdns.org")
    cards = {
        c["provider"]: c for c in (await client.get("/api/calendar/accounts")).json()["providers"]
    }
    assert (
        cards["google"]["redirect_uri"]
        == "https://galaxia-atlas.duckdns.org/api/calendar/google/callback"
    )
    assert (
        cards["microsoft"]["redirect_uri"]
        == "https://galaxia-atlas.duckdns.org/api/calendar/microsoft/callback"
    )
    url = await _start(client, headers, "google")
    assert parse_qs(urlsplit(url).query)["redirect_uri"] == [cards["google"]["redirect_uri"]]

    # The owner's tailnet-only setup serves HTTPS on :9443; the port is part of the redirect URI.
    monkeypatch.setattr(settings, "public_base_url", "https://galaxia-atlas.duckdns.org:9443/")
    cards = {
        c["provider"]: c for c in (await client.get("/api/calendar/accounts")).json()["providers"]
    }
    assert cards["google"]["configured"] is True
    assert (
        cards["google"]["redirect_uri"]
        == "https://galaxia-atlas.duckdns.org:9443/api/calendar/google/callback"
    )
    assert (
        cards["microsoft"]["redirect_uri"]
        == "https://galaxia-atlas.duckdns.org:9443/api/calendar/microsoft/callback"
    )
    url = await _start(client, headers, "microsoft")
    assert parse_qs(urlsplit(url).query)["redirect_uri"] == [cards["microsoft"]["redirect_uri"]]

    monkeypatch.setattr(settings, "public_base_url", "http://atlas.example.test")
    card = {
        c["provider"]: c for c in (await client.get("/api/calendar/accounts")).json()["providers"]
    }["google"]
    assert card["configured"] is False and "public_base_url_not_https" in card["setup_problems"]
    monkeypatch.setattr(
        settings, "public_base_url", "http://localhost:8000"
    )  # loopback http is fine for development
    card = {
        c["provider"]: c for c in (await client.get("/api/calendar/accounts")).json()["providers"]
    }["google"]
    assert card["configured"] is True


async def test_the_authorisation_request_asks_for_read_only_scopes_with_pkce_and_state(
    client, fake_provider
) -> None:
    headers = await _login(client)
    google = parse_qs(urlsplit(await _start(client, headers, "google")).query)
    assert google["scope"] == ["https://www.googleapis.com/auth/calendar.readonly"]
    assert google["code_challenge_method"] == ["S256"] and google["access_type"] == ["offline"]
    microsoft = parse_qs(urlsplit(await _start(client, headers, "microsoft")).query)
    assert set(microsoft["scope"][0].split()) == {"offline_access", "Calendars.Read"}
    assert len(google["state"][0]) >= 40 and google["state"] != microsoft["state"]
    for query in (google, microsoft):  # Stage B (write) scopes must not be requested in Stage A
        assert "ReadWrite" not in query["scope"][0] and "calendar.events" not in query["scope"][0]


async def test_google_connect_stores_encrypted_tokens_discovers_calendars_and_hides_secrets(
    client, fake_provider
) -> None:
    headers = await _login(client)
    landing = _result(await _connect(client, headers))
    assert landing == {"calendar_provider": "google", "calendar_result": "connected"}

    token_request = PROVIDER.token_requests[0]
    assert token_request["grant_type"] == "authorization_code" and token_request["code_verifier"]
    assert (
        token_request["redirect_uri"] == "https://atlas.example.test/api/calendar/google/callback"
    )

    async with session_scope() as session:
        credential = (await session.scalars(select(ProviderCredential))).one()
        secrets = [*PROVIDER.refresh_tokens, *PROVIDER.access_tokens]
        assert secrets and all(s.encode() not in credential.ciphertext for s in secrets)
        assert credential.needs_reauth_at is None
        assert "https://www.googleapis.com/auth/calendar.readonly" in credential.scopes

    card = {
        c["provider"]: c for c in (await client.get("/api/calendar/accounts")).json()["providers"]
    }["google"]
    assert card["connected"] and not card["needs_reauth"]
    by_name = {c["name"]: c for c in card["calendars"]}
    assert by_name["Owner"]["selected"] and by_name["Owner"]["is_primary"]
    assert not by_name["Holidays"]["selected"] and by_name["Holidays"]["is_read_only"]
    assert by_name["Owner"]["color"] != by_name["Holidays"]["color"]
    dump = (await client.get("/api/calendar/accounts")).text + (
        await client.get("/api/calendar/credentials")
    ).text
    assert (
        all(s not in dump for s in secrets) and "owner@example.test" not in dump
    )  # no provider ids


async def test_state_is_single_use(client, fake_provider) -> None:
    headers = await _login(client)
    redirect = await _browser(await _start(client, headers, "google"))
    target = urlsplit(redirect.headers["location"])
    first = await client.get(f"{target.path}?{target.query}")
    replay = await client.get(f"{target.path}?{target.query}")
    assert _result(first)["calendar_result"] == "connected"
    assert _result(replay)["calendar_result"] == "state_used"
    assert len(PROVIDER.token_requests) == 1  # the replay never reached the token endpoint


async def test_state_from_another_session_is_refused_before_any_provider_call(
    client, fake_provider, app
) -> None:
    headers = await _login(client)
    redirect = await _browser(await _start(client, headers, "google"))
    target = urlsplit(redirect.headers["location"])
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as other:
        login = await other.post(
            "/api/auth/login",
            json={"email": "owner@example.com", "password": "correct horse battery"},
        )
        assert login.status_code == 200
        forged = await other.get(f"{target.path}?{target.query}")
    assert _result(forged)["calendar_result"] == "invalid_state" and not PROVIDER.token_requests


@pytest.mark.parametrize("query", ["code=abc", "code=abc&state=forged", "state=forged&code=x"])
async def test_missing_or_forged_state_is_refused(client, fake_provider, query: str) -> None:
    await _login(client)
    response = await client.get(f"/api/calendar/google/callback?{query}")
    assert _result(response)["calendar_result"] == "invalid_state" and not PROVIDER.token_requests


async def test_an_expired_state_is_refused(client, fake_provider) -> None:
    headers = await _login(client)
    redirect = await _browser(await _start(client, headers, "google"))
    async with session_scope() as session:
        await session.execute(
            text("UPDATE oauth_states SET expires_at = now() - interval '1 minute'")
        )
    target = urlsplit(redirect.headers["location"])
    response = await client.get(f"{target.path}?{target.query}")
    assert _result(response)["calendar_result"] == "state_expired" and not PROVIDER.token_requests


async def test_the_user_cancelling_burns_the_state_and_reports_access_denied(
    client, fake_provider
) -> None:
    headers = await _login(client)
    PROVIDER.deny_authorize = True
    redirect = await _browser(await _start(client, headers, "google"))
    target = urlsplit(redirect.headers["location"])
    response = await client.get(f"{target.path}?{target.query}")
    assert _result(response)["calendar_result"] == "access_denied"
    async with session_scope() as session:
        assert (await session.scalars(select(ProviderCredential))).first() is None
        assert (
            await session.execute(
                text("SELECT count(*) FROM oauth_states WHERE used_at IS NOT NULL")
            )
        ).scalar_one() == 1


async def test_a_grant_without_the_required_scope_is_refused_and_nothing_is_stored(
    client, fake_provider
) -> None:
    headers = await _login(client)
    PROVIDER.granted_scope = "openid email"  # the user unticked the calendar checkbox
    assert _result(await _connect(client, headers))["calendar_result"] == "insufficient_scope"
    async with session_scope() as session:
        assert (await session.scalars(select(ProviderCredential))).first() is None


async def test_a_grant_without_a_refresh_token_is_refused(client, fake_provider) -> None:
    headers = await _login(client)
    PROVIDER.issue_refresh_token = False
    assert _result(await _connect(client, headers))["calendar_result"] == "no_refresh_token"


async def test_a_token_endpoint_failure_reports_a_safe_code(client, fake_provider) -> None:
    headers = await _login(client)
    redirect = await _browser(await _start(client, headers, "google"))
    target = urlsplit(redirect.headers["location"])
    PROVIDER.codes.clear()  # the provider no longer knows the code -> invalid_grant
    response = await client.get(f"{target.path}?{target.query}")
    assert _result(response)["calendar_result"] == "code_rejected"


async def test_tokens_codes_and_state_are_never_logged(client, fake_provider, caplog) -> None:
    headers = await _login(client)
    caplog.set_level(logging.DEBUG)
    authorization_url = await _start(client, headers, "google")
    state = parse_qs(urlsplit(authorization_url).query)["state"][0]
    redirect = await _browser(authorization_url)
    code = parse_qs(urlsplit(redirect.headers["location"]).query)["code"][0]
    target = urlsplit(redirect.headers["location"])
    await client.get(f"{target.path}?{target.query}")
    logged = "\n".join(f"{r.getMessage()} {r.__dict__}" for r in caplog.records)
    for secret in (*PROVIDER.refresh_tokens, *PROVIDER.access_tokens, code, state):
        assert secret not in logged


async def test_microsoft_refresh_tokens_rotate_and_the_new_pair_is_persisted(
    client, fake_provider
) -> None:
    headers = await _login(client)
    assert _result(await _connect(client, headers, "microsoft"))["calendar_result"] == "connected"
    original = next(iter(PROVIDER.refresh_tokens))
    PROVIDER.expire_access_tokens()
    response = await client.post("/api/calendar/providers/microsoft/sync", headers=headers)
    assert response.status_code == 200, response.text
    assert original not in PROVIDER.refresh_tokens and len(PROVIDER.refresh_tokens) == 1  # rotated
    again = await client.post("/api/calendar/providers/microsoft/sync", headers=headers)
    assert again.status_code == 200  # the rotated token was stored, so a second refresh works too


async def test_a_revoked_grant_flags_reauthorisation_and_reconnecting_clears_it(
    client, fake_provider
) -> None:
    headers = await _login(client)
    await _connect(client, headers)
    PROVIDER.expire_access_tokens()
    PROVIDER.fail_refresh = True
    failed = await client.post("/api/calendar/providers/google/sync", headers=headers)
    assert failed.status_code == 502
    card = {
        c["provider"]: c for c in (await client.get("/api/calendar/accounts")).json()["providers"]
    }["google"]
    assert card["needs_reauth"] is True and card["connected"]
    status = {
        p["provider"]: p
        for p in (await client.get("/api/calendar/sync-status")).json()["providers"]
    }
    assert status["google"]["needs_reauth"] is True
    PROVIDER.fail_refresh = False
    assert _result(await _connect(client, headers))["calendar_result"] == "connected"
    card = {
        c["provider"]: c for c in (await client.get("/api/calendar/accounts")).json()["providers"]
    }["google"]
    assert card["needs_reauth"] is False


async def test_disconnect_revokes_at_google_and_deletes_credentials_calendars_and_events(
    client, fake_provider
) -> None:
    headers = await _login(client)
    await _connect(client, headers)
    fake_provider.put_google_event(
        "owner@example.test",
        {
            "id": "e1",
            "status": "confirmed",
            "summary": "Dentist",
            "updated": "2026-11-01T10:00:00Z",
            "start": {"dateTime": "2026-11-10T09:00:00+01:00"},
            "end": {"dateTime": "2026-11-10T10:00:00+01:00"},
        },
    )
    assert (
        await client.post("/api/calendar/providers/google/sync", headers=headers)
    ).status_code == 200
    async with session_scope() as session:
        assert (await session.scalars(select(ExternalEvent))).first() is not None
    refresh = next(iter(PROVIDER.refresh_tokens))
    response = await client.delete("/api/calendar/accounts/google", headers=headers)
    assert response.status_code == 200
    body = response.json()
    assert (
        body["revoked_at_provider"] is True
        and body["events_removed"] == 1
        and body["calendars_removed"] == 2
    )
    assert PROVIDER.revoked == [refresh]
    async with session_scope() as session:
        for model in (ProviderCredential, CalendarSource, ExternalEvent):
            assert (await session.scalars(select(model))).first() is None
    assert (
        await client.delete("/api/calendar/accounts/google", headers=headers)
    ).status_code == 404


async def test_microsoft_disconnect_cannot_revoke_but_still_deletes_locally(
    client, fake_provider
) -> None:
    headers = await _login(client)
    await _connect(client, headers, "microsoft")
    body = (await client.delete("/api/calendar/accounts/microsoft", headers=headers)).json()
    assert body["revoked_at_provider"] is False and not PROVIDER.revoked
    async with session_scope() as session:
        assert (await session.scalars(select(ProviderCredential))).first() is None


async def test_connect_needs_a_session_and_csrf(client, fake_provider) -> None:
    assert (await client.post("/api/calendar/accounts/google/connect")).status_code in {401, 403}
    await _login(client)
    assert (
        await client.post("/api/calendar/accounts/google/connect")
    ).status_code == 403  # no CSRF header
    assert (await client.get("/api/calendar/accounts")).status_code == 200
