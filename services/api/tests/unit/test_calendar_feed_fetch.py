"""Fetching a secret ICS feed: conditional GET, size cap, redirects, safe errors (M5-11)."""

from __future__ import annotations

import pytest

from atlas.calendar import netguard
from atlas.calendar.feed import FeedError, FeedUnreachableError, fetch_feed
from atlas.config import get_settings

SECRET = "SECRETTOKEN-9f3a"
BODY = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:1\r\nDTSTART:20261110T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
URL = f"http://127.0.0.1:9911/ics/{SECRET}.ics"


async def test_a_feed_is_fetched_with_validators_and_a_conditional_request_gets_304(
    fake_provider,
) -> None:
    fake_provider.set_ics(f"{SECRET}.ics", BODY)
    first = await fetch_feed(URL)
    assert first.status == 200 and first.body == BODY.encode() and first.etag
    second = await fetch_feed(URL, etag=first.etag)
    assert second.not_modified and second.body == b""
    assert fake_provider.ics[f"{SECRET}.ics"]["conditional_hits"] == 1


@pytest.mark.parametrize("status", [401, 403, 404, 410])
async def test_a_revoked_or_missing_link_is_a_permanent_safe_error(
    fake_provider, status: int
) -> None:
    fake_provider.set_ics(f"{SECRET}.ics", BODY, status=status)
    with pytest.raises(FeedError) as raised:
        await fetch_feed(URL)
    assert (
        raised.value.code == "rejected"
        and SECRET not in str(raised.value)
        and "127.0.0.1" not in str(raised.value)
    )


@pytest.mark.parametrize("status", [429, 500, 502, 503])
async def test_server_errors_are_transient(fake_provider, status: int) -> None:
    fake_provider.set_ics(f"{SECRET}.ics", BODY, status=status)
    with pytest.raises(FeedUnreachableError) as raised:
        await fetch_feed(URL)
    assert raised.value.retryable and SECRET not in str(raised.value)


async def test_an_html_page_is_not_accepted_as_a_calendar(fake_provider) -> None:
    fake_provider.set_ics(f"{SECRET}.ics", "<html>login</html>", content_type="text/html")
    with pytest.raises(FeedError) as raised:
        await fetch_feed(URL)
    assert raised.value.code == "not_calendar"


async def test_the_size_cap_applies_to_the_streamed_body(
    fake_provider, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(get_settings(), "ics_max_bytes", 1024)
    fake_provider.set_ics(f"{SECRET}.ics", BODY + "X-FILL:" + "a" * 5000 + "\r\n")
    with pytest.raises(FeedError) as raised:
        await fetch_feed(URL)
    assert raised.value.code == "too_large"


async def test_a_redirect_to_an_internal_address_is_refused(
    fake_provider, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = get_settings()
    monkeypatch.setattr(settings, "ics_allow_private_hosts", False)
    monkeypatch.setattr(settings, "ics_allow_http", True)

    async def public(host: str, port: int) -> list[str]:
        return ["93.184.216.34"] if host == "feed.example.test" else await real(host, port)

    real = netguard.resolve_addresses
    monkeypatch.setattr(netguard, "resolve_addresses", public)
    fake_provider.set_ics(
        f"{SECRET}.ics", BODY, location="http://169.254.169.254/latest/meta-data/"
    )
    with pytest.raises(FeedError) as raised:
        await fetch_feed(f"https://feed.example.test/ics/{SECRET}.ics")
    assert raised.value.code == "blocked_address"
    assert not any(path.startswith("/latest") for _, path in fake_provider.requests)


async def test_a_redirect_loop_is_bounded(fake_provider, monkeypatch: pytest.MonkeyPatch) -> None:
    fake_provider.set_ics(f"{SECRET}.ics", BODY, location=URL)
    with pytest.raises(FeedError) as raised:
        await fetch_feed(URL)
    assert raised.value.code == "too_many_redirects"


async def test_an_internal_url_is_refused_without_any_request(
    fake_provider, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(get_settings(), "ics_allow_private_hosts", False)
    fake_provider.set_ics(f"{SECRET}.ics", BODY)
    with pytest.raises(FeedError) as raised:
        await fetch_feed(URL)
    assert raised.value.code == "blocked_address"
    assert fake_provider.ics[f"{SECRET}.ics"]["hits"] == 0
