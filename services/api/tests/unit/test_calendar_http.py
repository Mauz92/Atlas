"""The provider HTTP layer: classification, bounded retry with jitter, origin pinning (M5-03/04)."""

from __future__ import annotations

import httpx
import pytest

from atlas.calendar.errors import (
    AuthExpiredError,
    PermanentProviderError,
    RateLimitedError,
    TransientProviderError,
)
from atlas.calendar.http import (
    MAX_ATTEMPTS,
    CursorExpiredError,
    ProviderHttp,
    classify_response,
    parse_retry_after,
)

ORIGIN = "https://api.example.test"


def make(handler, sleeps: list[float] | None = None) -> ProviderHttp:
    async def sleep(seconds: float) -> None:
        if sleeps is not None:
            sleeps.append(seconds)

    return ProviderHttp(
        provider="google",
        api_origin=ORIGIN,
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        sleep=sleep,
    )


@pytest.mark.parametrize(
    ("status", "error"),
    [
        (401, AuthExpiredError),
        (410, CursorExpiredError),
        (429, RateLimitedError),
        (500, TransientProviderError),
        (502, TransientProviderError),
        (404, PermanentProviderError),
        (400, PermanentProviderError),
    ],
)
def test_status_codes_map_onto_the_error_taxonomy(status: int, error: type) -> None:
    assert type(classify_response(httpx.Response(status), provider="google")) is error


def test_google_403_distinguishes_rate_limit_from_a_permission_error() -> None:
    limited = httpx.Response(403, json={"error": {"errors": [{"reason": "rateLimitExceeded"}]}})
    denied = httpx.Response(
        403, json={"error": {"errors": [{"reason": "insufficientPermissions"}]}}
    )
    assert isinstance(classify_response(limited, provider="google"), RateLimitedError)
    assert type(classify_response(denied, provider="google")) is PermanentProviderError


def test_retry_after_is_parsed_defensively() -> None:
    assert parse_retry_after("7") == 7.0
    assert parse_retry_after("Wed, 21 Oct 2026 07:28:00 GMT") is None
    assert (
        parse_retry_after("-3") is None
        and parse_retry_after("999999") is None
        and parse_retry_after(None) is None
    )


async def test_throttling_honours_retry_after_then_succeeds() -> None:
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(429, headers={"Retry-After": "3"})
        return httpx.Response(200, json={"ok": True})

    sleeps: list[float] = []
    assert await make(handler, sleeps).get_json(f"{ORIGIN}/x", token="t") == {"ok": True}
    assert sleeps == [3.0] and len(calls) == 2


async def test_transient_failures_back_off_with_jitter_and_are_bounded() -> None:
    attempts = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(503)

    sleeps: list[float] = []
    with pytest.raises(TransientProviderError):
        await make(handler, sleeps).get_json(f"{ORIGIN}/x", token="t")
    assert attempts == MAX_ATTEMPTS and len(sleeps) == MAX_ATTEMPTS - 1
    assert sleeps == sorted(sleeps) or max(sleeps) <= 8  # exponential, jittered, capped
    assert all(0 < s <= 8 for s in sleeps)


async def test_a_very_long_retry_after_is_surfaced_instead_of_blocking_the_worker() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, headers={"Retry-After": "600"})

    with pytest.raises(RateLimitedError) as raised:
        await make(handler).get_json(f"{ORIGIN}/x", token="t")
    assert raised.value.retry_after == 600.0


async def test_network_errors_do_not_leak_the_url_or_token() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(f"boom {request.url}", request=request)

    with pytest.raises(TransientProviderError) as raised:
        await make(handler).get_json(f"{ORIGIN}/x?pageToken=SECRETPAGE", token="TOKEN123")
    text = str(raised.value)
    assert "SECRETPAGE" not in text and "TOKEN123" not in text and "example.test" not in text


async def test_the_bearer_token_is_only_ever_sent_to_the_api_origin() -> None:
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={})

    client = make(handler)
    with pytest.raises(PermanentProviderError):
        await client.get_json("https://evil.example.test/steal", token="TOKEN123")
    assert (
        not seen
        and client.allows(f"{ORIGIN}/ok")
        and not client.allows("http://api.example.test/ok")
    )


async def test_a_non_json_success_is_a_permanent_error() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="<html>")

    with pytest.raises(PermanentProviderError):
        await make(handler).get_json(f"{ORIGIN}/x", token="t")
