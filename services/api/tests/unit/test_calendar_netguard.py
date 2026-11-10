"""SSRF protection for user-supplied feed URLs (SECURITY T24, M5-11)."""

from __future__ import annotations

import pytest

from atlas.calendar import netguard
from atlas.calendar.netguard import (
    UnsafeUrlError,
    is_global_address,
    mask_feed_url,
    parse_feed_url,
    validate_target,
)
from atlas.config import Settings


def settings(**kwargs) -> Settings:
    return Settings(**kwargs)


@pytest.mark.parametrize(
    "address",
    [
        "127.0.0.1",
        "127.1.2.3",
        "10.0.0.5",
        "172.16.0.1",
        "172.31.255.255",
        "192.168.1.1",
        "169.254.169.254",
        "169.254.0.1",
        "100.64.0.1",
        "0.0.0.0",
        "255.255.255.255",
        "224.0.0.1",
        "::1",
        "::",
        "fe80::1",
        "fc00::1",
        "fd12:3456::1",
        "ff02::1",
        "::ffff:127.0.0.1",
        "::ffff:10.0.0.1",
        "::ffff:169.254.169.254",
        "64:ff9b::7f00:1",
    ],
)
def test_private_loopback_link_local_and_mapped_addresses_are_not_global(address: str) -> None:
    assert not is_global_address(address)


@pytest.mark.parametrize(
    "address", ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8"]
)
def test_public_addresses_are_global(address: str) -> None:
    assert is_global_address(address)


@pytest.mark.parametrize(
    ("url", "code"),
    [
        ("", "invalid_url"),
        ("ftp://example.test/a.ics", "invalid_url"),
        ("file:///etc/passwd", "invalid_url"),
        ("javascript:alert(1)", "invalid_url"),
        ("http://example.test/a.ics", "https_required"),
        ("https://user:pw@example.test/a.ics", "invalid_url"),
        ("https://", "invalid_url"),
        ("https://example.test:0/a.ics", "invalid_url"),
        ("https://exa mple.test/a.ics", "invalid_url"),
        ("https://example.test/" + "a" * 3000, "invalid_url"),
    ],
)
def test_url_syntax_is_validated(url: str, code: str) -> None:
    with pytest.raises(UnsafeUrlError) as raised:
        parse_feed_url(url, settings())
    assert raised.value.code == code


def test_webcal_is_accepted_as_https_and_http_only_when_allowed() -> None:
    assert parse_feed_url("webcal://calendar.example.test/x.ics", settings()).scheme == "https"
    assert (
        parse_feed_url("http://calendar.example.test/x.ics", settings(ics_allow_http=True)).scheme
        == "http"
    )


@pytest.mark.parametrize(
    "url",
    [
        "https://127.0.0.1/a.ics",
        "https://localhost/a.ics",
        "https://169.254.169.254/latest/meta-data/",
        "https://[::1]/a.ics",
        "https://[::ffff:169.254.169.254]/a.ics",
        "https://10.1.2.3:8443/a.ics",
        "https://192.168.0.10/a.ics",
        "https://0.0.0.0/a.ics",
        "https://2130706433/a.ics",  # decimal 127.0.0.1
        "https://0x7f000001/a.ics",  # hex 127.0.0.1
    ],
)
async def test_internal_targets_are_refused_after_resolution(url: str) -> None:
    with pytest.raises(UnsafeUrlError) as raised:
        await validate_target(url, settings())
    assert raised.value.code in {"blocked_address", "unresolvable"}


async def test_a_hostname_that_resolves_to_a_private_address_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_resolve(host: str, port: int) -> list[str]:
        return ["93.184.216.34", "10.0.0.7"]  # one public, one private: refuse (rebinding mixes)

    monkeypatch.setattr(netguard, "resolve_addresses", fake_resolve)
    with pytest.raises(UnsafeUrlError) as raised:
        await validate_target("https://calendar.example.test/x.ics", settings())
    assert raised.value.code == "blocked_address"


async def test_a_public_target_is_pinned_to_the_validated_address(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_resolve(host: str, port: int) -> list[str]:
        return ["93.184.216.34"]

    monkeypatch.setattr(netguard, "resolve_addresses", fake_resolve)
    target = await validate_target("https://calendar.example.test/p/secret.ics?k=v", settings())
    assert target.pinned_url == "https://93.184.216.34:443/p/secret.ics?k=v"
    assert target.host_header == "calendar.example.test"


async def test_private_hosts_can_be_allowed_for_development_only() -> None:
    target = await validate_target(
        "http://127.0.0.1:9911/x.ics", settings(ics_allow_http=True, ics_allow_private_hosts=True)
    )
    assert target.address == "127.0.0.1" and target.host_header == "127.0.0.1:9911"


def test_the_masked_form_never_contains_the_secret_path() -> None:
    masked = mask_feed_url(
        "https://calendar.proton.me/api/calendar/v1/url/SECRETTOKEN123/calendar.ics?CacheKey=abc"
    )
    assert (
        "SECRET" not in masked
        and "CacheKey" not in masked
        and masked.startswith("https://calendar.proton.me/")
    )


def test_production_refuses_the_private_host_and_fake_provider_flags() -> None:
    base = {
        "atlas_env": "production",
        "secret_key": "s",
        "session_secret": "s",
        "token_encryption_key": "k",
    }
    with pytest.raises(RuntimeError, match="ICS_ALLOW_PRIVATE_HOSTS"):
        Settings(**base, ics_allow_private_hosts=True).validate_for_runtime()
    with pytest.raises(RuntimeError, match="CALENDAR_FAKE_PROVIDER_URL"):
        Settings(**base, calendar_fake_provider_url="http://x").validate_for_runtime()
    Settings(**base).validate_for_runtime()
