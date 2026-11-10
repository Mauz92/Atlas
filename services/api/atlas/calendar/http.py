"""The shared HTTP layer for provider adapters (M5-03/M5-04, ADR-0071).

Every Google/Microsoft call goes through :class:`ProviderHttp`, which

- sends the bearer token **only** to the allowed API origin (a ``nextLink``/page token pointing
  anywhere else is refused, so a hostile or corrupted link cannot make Atlas leak its token);
- maps every failure onto the provider-error taxonomy (:mod:`atlas.calendar.errors`) with
  **content-free** messages - no URL query, header, body or token ever reaches an error text, a log
  line or the sync status (AGENTS.md §11);
- retries transient failures (network errors, ``5xx``) and throttling (``429``/``503`` with
  ``Retry-After``) with **bounded** exponential backoff and jitter (AGENTS.md §10), honouring the
  provider's ``Retry-After`` up to a cap, then raises so the failure is recorded and the scan
  retries
  later. The cursor is never touched here.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping
from typing import Any
from urllib.parse import urlsplit

import httpx

from ..jobs.queue import backoff_delay
from .errors import (
    AuthExpiredError,
    PermanentProviderError,
    ProviderError,
    RateLimitedError,
    TransientProviderError,
)

#: In-call retries before the error is surfaced (the periodic scan retries again later).
MAX_ATTEMPTS = 4
#: The longest ``Retry-After`` honoured inside one call; a longer one is surfaced to the scan.
MAX_INLINE_RETRY_AFTER = 30.0
DEFAULT_TIMEOUT = 30.0

Sleeper = Callable[[float], Awaitable[None]]

#: Tests install an ``httpx`` transport here (an in-process ASGI fake provider); ``None`` is the
#: real
#: network. Process-wide on purpose: the OAuth service, the adapters and the ICS fetcher all use it.
_transport: httpx.AsyncBaseTransport | None = None


def set_transport(transport: httpx.AsyncBaseTransport | None) -> None:
    """Install (or clear) the transport every provider client uses. Tests only."""
    global _transport
    _transport = transport


def new_client(*, timeout: float = DEFAULT_TIMEOUT) -> httpx.AsyncClient:
    """A client that never follows redirects (a redirect could leave the allowed origin)."""
    return httpx.AsyncClient(timeout=timeout, follow_redirects=False, transport=_transport)


class CursorExpiredError(PermanentProviderError):
    """``410 Gone``: the incremental cursor is no longer valid, a full resync is required.

    Permanent for *this* cursor, but not for the calendar: the adapter catches it and restarts as a
    full listing (CALENDAR_SYNC §4), so it normally never reaches the sync layer.
    """


def parse_retry_after(value: str | None) -> float | None:
    """Seconds from a ``Retry-After`` header given as delta-seconds (the HTTP-date form is
    ignored)."""
    if value is None:
        return None
    try:
        seconds = float(value.strip())
    except ValueError:
        return None
    return seconds if 0 <= seconds < 86_400 else None


def _reason_of(response: httpx.Response) -> str:
    """The Google error ``reason`` / Graph error ``code`` (a short machine token), else ``""``."""
    try:
        body = response.json()
    except ValueError:
        return ""
    error = body.get("error") if isinstance(body, dict) else None
    if isinstance(error, dict):
        errors = error.get("errors")
        if isinstance(errors, list) and errors and isinstance(errors[0], dict):
            reason = errors[0].get("reason")
            if isinstance(reason, str):
                return reason[:64]
        code = error.get("code")
        if isinstance(code, str):
            return code[:64]
    return ""


_THROTTLE_REASONS = frozenset(
    {"ratelimitexceeded", "userratelimitexceeded", "quotaexceeded", "dailylimitexceeded"}
)


def classify_response(response: httpx.Response, *, provider: str) -> ProviderError | None:
    """The :class:`ProviderError` for a non-success response, or ``None`` for ``2xx``/``3xx``."""
    status = response.status_code
    if status < 400:
        return None
    reason = _reason_of(response).lower()
    retry_after = parse_retry_after(response.headers.get("Retry-After"))
    if status == 401:
        return AuthExpiredError("the provider rejected the stored sign-in", provider=provider)
    if status == 410:
        return CursorExpiredError("the provider invalidated the sync cursor", provider=provider)
    if status == 429 or (status == 503 and retry_after is not None):
        return RateLimitedError(retry_after=retry_after, provider=provider)
    if status == 403:
        if reason in _THROTTLE_REASONS:
            return RateLimitedError(retry_after=retry_after, provider=provider)
        return PermanentProviderError(
            "the provider denied access (permission or scope missing)", provider=provider
        )
    if status in (408, 409) or status >= 500:
        return TransientProviderError(f"the provider answered HTTP {status}", provider=provider)
    return PermanentProviderError(f"the provider answered HTTP {status}", provider=provider)


class ProviderHttp:
    """A bearer-authenticated JSON client restricted to one API origin."""

    def __init__(
        self,
        *,
        provider: str,
        api_origin: str,
        client: httpx.AsyncClient | None = None,
        sleep: Sleeper | None = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        self.provider = provider
        parts = urlsplit(api_origin)
        self._origin = (parts.scheme, parts.netloc.lower())
        self._client = client
        self._owns_client = client is None
        self._sleep = sleep or asyncio.sleep
        self._timeout = timeout

    def allows(self, url: str) -> bool:
        """Whether ``url`` is on the API origin the bearer token may be sent to."""
        parts = urlsplit(url)
        return (parts.scheme, parts.netloc.lower()) == self._origin

    async def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = new_client(timeout=self._timeout)
        return self._client

    async def aclose(self) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    async def get_json(
        self,
        url: str,
        *,
        token: str,
        params: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> dict[str, Any]:
        """``GET`` ``url`` and return the JSON object, applying retry/backoff and error mapping."""
        if not self.allows(url):
            raise PermanentProviderError("refusing to send credentials to another origin")
        request_headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
        request_headers.update(headers or {})
        client = await self._http()
        last: ProviderError | None = None
        for attempt in range(1, MAX_ATTEMPTS + 1):
            try:
                response = await client.get(url, params=params, headers=request_headers)
            except httpx.HTTPError:
                # No exception text: httpx messages can contain the URL (and so a query).
                last = TransientProviderError(
                    "could not reach the provider", provider=self.provider
                )
            else:
                error = classify_response(response, provider=self.provider)
                if error is None:
                    try:
                        data = response.json()
                    except ValueError as exc:
                        raise PermanentProviderError(
                            "the provider returned an unreadable response", provider=self.provider
                        ) from exc
                    if not isinstance(data, dict):
                        raise PermanentProviderError(
                            "the provider returned an unexpected response", provider=self.provider
                        )
                    return data
                if not error.retryable:
                    raise error
                last = error
            if attempt == MAX_ATTEMPTS:
                break
            delay = backoff_delay(attempt, base=1.0)
            if isinstance(last, RateLimitedError) and last.retry_after is not None:
                if last.retry_after > MAX_INLINE_RETRY_AFTER:
                    raise last
                delay = last.retry_after
            await self._sleep(delay)
        assert last is not None
        raise last
