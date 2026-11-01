"""Pure destination-registry rules (M8-03).

No database: these exercise :mod:`atlas.notifications.registry` — channel/endpoint normalisation
and validation, the Web Push key requirement, the active/disabled semantics and the clean-up of the
endpoints a delivery reports invalid.
"""

from __future__ import annotations

import pytest

from atlas.notifications import (
    KNOWN_CHANNELS,
    MAX_ENDPOINT_LENGTH,
    MAX_PLATFORM_LENGTH,
    InvalidDeviceError,
    build_destination_key,
    build_registration,
    clean_reported_endpoints,
    device_is_active,
    is_web,
    normalise_channel,
)


def test_known_channels_are_the_push_channels() -> None:
    assert sorted(KNOWN_CHANNELS) == ["android", "ios", "web"]


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("web", "web"), (" WEB ", "web"), ("Android", "android"), ("iOS", "ios")],
)
def test_channels_are_normalised(raw: str, expected: str) -> None:
    assert normalise_channel(raw) == expected


@pytest.mark.parametrize("raw", ["", "   ", "desktop", "windows"])
def test_unknown_channels_are_rejected(raw: str) -> None:
    with pytest.raises(InvalidDeviceError):
        normalise_channel(raw)


def test_is_web_only_for_the_web_channel() -> None:
    assert is_web("web") is True
    assert is_web("android") is False
    assert is_web("ios") is False


def test_a_web_registration_carries_the_endpoint_and_the_client_keys() -> None:
    registration = build_registration(
        " WEB ", " https://push.example/abc ", p256dh=" PUBLIC ", auth="SECRET"
    )
    assert registration.channel == "web"
    assert registration.endpoint == "https://push.example/abc"
    assert registration.p256dh == "PUBLIC"
    assert registration.auth == "SECRET"
    assert registration.key == ("web", "https://push.example/abc")


@pytest.mark.parametrize(("p256dh", "auth"), [(None, "s"), ("k", None), (None, None), ("", "  ")])
def test_a_web_registration_without_both_keys_is_rejected(
    p256dh: str | None, auth: str | None
) -> None:
    with pytest.raises(InvalidDeviceError):
        build_registration("web", "https://push.example/abc", p256dh=p256dh, auth=auth)


@pytest.mark.parametrize("channel", ["android", "ios"])
def test_a_native_registration_uses_the_token_and_no_web_keys(channel: str) -> None:
    registration = build_registration(channel, " fcm-token-123 ", platform=" Pixel 9 ")
    assert registration.channel == channel
    assert registration.endpoint == "fcm-token-123"
    assert registration.p256dh is None
    assert registration.auth is None
    assert registration.platform == "Pixel 9"


@pytest.mark.parametrize("channel", ["android", "ios"])
def test_native_registrations_reject_web_keys(channel: str) -> None:
    with pytest.raises(InvalidDeviceError):
        build_registration(channel, "token", p256dh="k", auth="s")


def test_an_empty_endpoint_is_rejected() -> None:
    with pytest.raises(InvalidDeviceError):
        build_registration("android", "   ")


def test_an_over_long_endpoint_is_rejected() -> None:
    with pytest.raises(InvalidDeviceError):
        build_registration("android", "x" * (MAX_ENDPOINT_LENGTH + 1))


def test_an_over_long_platform_is_rejected() -> None:
    with pytest.raises(InvalidDeviceError):
        build_registration("ios", "token", platform="p" * (MAX_PLATFORM_LENGTH + 1))


def test_destination_key_validation_needs_no_web_keys() -> None:
    key = build_destination_key("web", "https://push.example/abc")
    assert key.key == ("web", "https://push.example/abc")
    assert key.p256dh is None and key.auth is None
    with pytest.raises(InvalidDeviceError):
        build_destination_key("nope", "https://push.example/abc")


def test_a_blank_platform_is_stored_as_none() -> None:
    assert build_registration("ios", "token", platform="  ").platform is None


def test_device_active_semantics() -> None:
    assert device_is_active(disabled_at=None) is True
    assert device_is_active(disabled_at=object()) is False


def test_reported_endpoints_are_cleaned_and_deduplicated() -> None:
    assert clean_reported_endpoints([" a ", "", "b", "a", "  "]) == ["a", "b"]
    assert clean_reported_endpoints([]) == []


def test_a_validation_error_never_echoes_the_supplied_secret() -> None:
    secret = "SUPERSECRET-AUTH"
    with pytest.raises(InvalidDeviceError) as excinfo:
        # Missing p256dh: the message must name the field, never the auth secret that was supplied.
        build_registration("web", "https://push.example/abc", auth=secret)
    assert secret not in str(excinfo.value)
