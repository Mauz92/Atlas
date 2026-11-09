"""The hint gateway pieces without a database (M8-04e): the SSRF origin table, the ntfy adapter's
request and classification, the breaker, the constant payload and the wait registry."""

from __future__ import annotations

import json
import uuid

import httpx
import pytest

from atlas.api.sync_wait import WaitRegistry
from atlas.hints import (
    HINT_PAYLOAD,
    HintOutcome,
    InvalidGatewayConfigError,
    InvalidHintEndpointError,
    parse_gateway_origin,
    validate_endpoint,
)
from atlas.hints.ntfy import NtfyGateway
from atlas.hints.service import CircuitBreaker

ORIGIN = parse_gateway_origin("https://ntfy.example.net", production=True)
TOPIC = "https://ntfy.example.net/upAbCdEfGhIj0123"


# --- the configured origin ----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("url", "kwargs", "base"),
    [
        ("https://ntfy.example.net", {}, "https://ntfy.example.net"),
        ("https://NTFY.example.net/", {}, "https://ntfy.example.net"),
        ("https://ntfy.example.net:8443", {}, "https://ntfy.example.net:8443"),
        ("https://ntfy.example.net:443", {}, "https://ntfy.example.net"),
        ("http://127.0.0.1:2586", {"production": False}, "http://127.0.0.1:2586"),
        ("http://localhost:2586", {"production": False}, "http://localhost:2586"),
        ("http://ntfy.lan:2586", {"allow_insecure_http": True}, "http://ntfy.lan:2586"),
        ("http://100.64.1.5", {"allow_insecure_http": True}, "http://100.64.1.5"),
        ("https://[::1]:8443", {}, "https://[::1]:8443"),
    ],
)
def test_accepted_gateway_origins(url: str, kwargs: dict[str, bool], base: str) -> None:
    options = {"production": True, **kwargs}
    assert parse_gateway_origin(url, **options).base == base


@pytest.mark.parametrize(
    ("url", "kwargs"),
    [
        ("", {}),
        ("ntfy.example.net", {}),
        ("ftp://ntfy.example.net", {}),
        ("https://", {}),
        ("https://user:pw@ntfy.example.net", {}),
        ("https://ntfy.example.net/some/path", {}),
        ("https://ntfy.example.net?x=1", {}),
        ("https://ntfy.example.net#frag", {}),
        ("https://ntfy.example.net:99999", {}),
        ("http://ntfy.example.net", {"production": False}),  # http, not loopback, no opt-in
        ("http://127.0.0.1:2586", {"production": True}),  # loopback http only outside production
        ("http://ntfy.lan", {"production": True}),
    ],
)
def test_refused_gateway_origins(url: str, kwargs: dict[str, bool]) -> None:
    options = {"production": True, **kwargs}
    with pytest.raises(InvalidGatewayConfigError):
        parse_gateway_origin(url, **options)


# --- the registered endpoint (the SSRF table) ----------------------------------------------------


def test_a_topic_on_the_configured_origin_is_accepted_and_normalised() -> None:
    assert validate_endpoint(TOPIC, ORIGIN) == TOPIC
    assert validate_endpoint(TOPIC.replace("ntfy", "NTFY"), ORIGIN) == TOPIC
    assert validate_endpoint("https://ntfy.example.net:443/upAbCdEfGhIj0123", ORIGIN) == TOPIC


@pytest.mark.parametrize(
    "endpoint",
    [
        "",
        " ",
        "x" * 600,
        "https://evil.example.org/upAbCdEfGhIj0123",  # another host
        "https://ntfy.example.net.evil.org/upAbCdEfGhIj0123",  # suffix trick
        "https://evil.org@ntfy.example.net/upAbCdEfGhIj0123",  # userinfo
        "https://ntfy.example.net@evil.org/upAbCdEfGhIj0123",  # userinfo, other host
        "https://user:pw@ntfy.example.net/upAbCdEfGhIj0123",
        "https://ntfy.example.net:8443/upAbCdEfGhIj0123",  # another port
        "http://ntfy.example.net/upAbCdEfGhIj0123",  # downgrade
        "https://127.0.0.1/upAbCdEfGhIj0123",  # IP literal that is not the origin
        "https://[::1]/upAbCdEfGhIj0123",
        "https://169.254.169.254/latest/meta-data",
        "https://ntfy.example.net/",
        "https://ntfy.example.net",
        "https://ntfy.example.net/up",
        "https://ntfy.example.net/upshort",
        "https://ntfy.example.net/up" + "a" * 65,
        "https://ntfy.example.net/../upAbCdEfGhIj0123",
        "https://ntfy.example.net/up/../etc/passwd1234",
        "https://ntfy.example.net/upAbCdEfGhIj0123/extra",
        "https://ntfy.example.net/upAbCdEfGhIj0123?x=1",
        "https://ntfy.example.net/upAbCdEfGhIj0123#f",
        "https://ntfy.example.net/up%41bCdEfGhIj0123",  # percent escapes
        "https://ntfy.example.net/upAbCdEfGhIj0123 ",
        "https://ntfy.example.net\\@evil.org/upAbCdEfGhIj0123",
        "https://ntfy.example.net/upAbCdEfGhIj01é23",  # non-ASCII
        "//ntfy.example.net/upAbCdEfGhIj0123",
        "file:///etc/passwd",
        "gopher://ntfy.example.net/upAbCdEfGhIj0123",
    ],
)
def test_every_other_endpoint_is_refused_without_echoing_it(endpoint: str) -> None:
    with pytest.raises(InvalidHintEndpointError) as caught:
        validate_endpoint(endpoint, ORIGIN)
    assert endpoint.strip() == "" or endpoint not in str(caught.value)


def test_an_ip_literal_origin_pins_that_ip_only() -> None:
    origin = parse_gateway_origin("http://10.0.0.7:2586", production=True, allow_insecure_http=True)
    assert validate_endpoint("http://10.0.0.7:2586/upAbCdEfGhIj0123", origin)
    with pytest.raises(InvalidHintEndpointError):
        validate_endpoint("http://10.0.0.8:2586/upAbCdEfGhIj0123", origin)


# --- the adapter ---------------------------------------------------------------------------------


def _gateway(handler, **kwargs) -> NtfyGateway:
    return NtfyGateway(ORIGIN, transport=httpx.MockTransport(handler), **kwargs)


async def test_the_request_is_the_constant_payload_and_nothing_else() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"id": "x"})

    result = await _gateway(handler, token="tk_secret").send(TOPIC)
    assert result.outcome is HintOutcome.DELIVERED
    (request,) = seen
    assert request.method == "POST" and str(request.url) == TOPIC
    assert request.content == HINT_PAYLOAD == b'{"v":1,"k":"sync"}'
    assert json.loads(request.content) == {"v": 1, "k": "sync"}
    assert request.headers["authorization"] == "Bearer tk_secret"
    assert request.headers["cache"] == "no" and request.headers["firebase"] == "no"
    assert {"title", "tags", "priority", "x-title", "x-tags", "x-priority"}.isdisjoint(
        request.headers.keys()
    )


async def test_no_token_means_no_authorization_header() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200)

    await _gateway(handler).send(TOPIC)
    assert "authorization" not in seen[0].headers


@pytest.mark.parametrize(
    ("status", "outcome", "error_class"),
    [
        (200, HintOutcome.DELIVERED, None),
        (202, HintOutcome.DELIVERED, None),
        (404, HintOutcome.INVALID, "gone"),
        (410, HintOutcome.INVALID, "gone"),
        (507, HintOutcome.INVALID, "gone"),
        (429, HintOutcome.RETRY, "rate_limited"),
        (500, HintOutcome.RETRY, "gateway_error"),
        (503, HintOutcome.RETRY, "gateway_error"),
        (301, HintOutcome.FAILED, "redirect"),
        (307, HintOutcome.FAILED, "redirect"),
        (401, HintOutcome.FAILED, "rejected"),
        (403, HintOutcome.FAILED, "rejected"),
        (400, HintOutcome.FAILED, "rejected"),
    ],
)
async def test_statuses_are_classified(
    status: int, outcome: HintOutcome, error_class: str | None
) -> None:
    result = await _gateway(lambda r: httpx.Response(status)).send(TOPIC)
    assert (result.outcome, result.error_class) == (outcome, error_class)


async def test_retry_after_of_a_429_is_carried() -> None:
    result = await _gateway(lambda r: httpx.Response(429, headers={"Retry-After": "12"})).send(
        TOPIC
    )
    assert result.retry_after == 12.0


async def test_a_redirect_is_never_followed() -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(302, headers={"Location": "http://169.254.169.254/latest/meta-data"})

    result = await _gateway(handler).send(TOPIC)
    assert result.outcome is HintOutcome.FAILED and result.error_class == "redirect"
    assert calls == [TOPIC]


async def test_timeouts_and_connection_errors_are_retryable_and_do_not_raise() -> None:
    def timeout(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    def refused(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    assert (await _gateway(timeout).send(TOPIC)).error_class == "timeout"
    assert (await _gateway(refused).send(TOPIC)).error_class == "unreachable"
    assert (await _gateway(refused).send(TOPIC)).outcome is HintOutcome.RETRY


async def test_an_endpoint_off_the_origin_is_refused_at_send_time_too() -> None:
    called = False

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal called
        called = True
        return httpx.Response(200)

    result = await _gateway(handler, token="tk_x").send("https://evil.example.org/upAbCdEfGhIj0123")
    assert result.outcome is HintOutcome.FAILED and not called  # the token never leaves


# --- breaker and registry -----------------------------------------------------------


def test_the_breaker_opens_after_five_failures_and_probes_after_the_cooldown() -> None:
    now = [0.0]
    gate = CircuitBreaker(clock=lambda: now[0])
    for _ in range(4):
        gate.record(ok=False)
    assert gate.allow()
    gate.record(ok=False)
    assert not gate.allow()
    now[0] = 299
    assert not gate.allow()
    now[0] = 301
    assert gate.allow()  # half-open: one probe
    gate.record(ok=False)
    assert not gate.allow()  # the probe failed: closed again for another cooldown
    now[0] = 700
    assert gate.allow()
    gate.record(ok=True)
    assert gate.failures == 0 and gate.allow()


def test_a_success_resets_the_failure_count() -> None:
    gate = CircuitBreaker()
    for _ in range(4):
        gate.record(ok=False)
    gate.record(ok=True)
    for _ in range(4):
        gate.record(ok=False)
    assert gate.allow()


def test_the_wait_registry_evicts_the_oldest_beyond_the_cap() -> None:
    registry = WaitRegistry()
    user = uuid.uuid4()
    waiters = [registry.acquire(user, 2) for _ in range(3)]
    assert registry.held(user) == 2
    assert waiters[0].evicted.is_set() and not waiters[1].evicted.is_set()
    registry.release(user, waiters[1])
    registry.release(user, waiters[2])
    registry.release(user, waiters[0])  # releasing an evicted waiter is harmless
    assert registry.held(user) == 0
    other = registry.acquire(uuid.uuid4(), 1)
    assert not other.evicted.is_set()
