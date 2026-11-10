"""Fetching a secret ICS feed safely (M5-11, ADR-0071).

One bounded, conditional ``GET`` per poll: validated and pinned address (:mod:`netguard`), manual
redirects (each hop re-validated, at most :data:`MAX_REDIRECTS`), a streamed body capped at
``ICS_MAX_BYTES`` on the *decoded* size (a compression bomb cannot exceed it), an overall deadline,
a
content-type sanity check and a ``BEGIN:VCALENDAR`` check. Failures raise :class:`FeedError` whose
message is user-safe and **never contains the URL** (it is a secret): neither errors, logs nor the
sync status can leak it.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from urllib.parse import urljoin

import httpx

from ..config import Settings, get_settings
from .errors import PermanentProviderError, TransientProviderError
from .http import new_client
from .netguard import UnsafeUrlError, ValidatedTarget, validate_target

MAX_REDIRECTS = 3
USER_AGENT = "Atlas-calendar-feed/1 (self-hosted; read-only)"
_OK_TYPES = (
    "text/calendar",
    "text/plain",
    "application/octet-stream",
    "application/ics",
    "text/x-vcalendar",
)


class FeedError(PermanentProviderError):
    """A feed failed permanently (blocked, rejected, malformed). ``code`` is stable."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message, provider="ics")
        self.code = code


class FeedUnreachableError(TransientProviderError):
    """The feed host did not answer (timeout, connection error, 5xx): retried later."""

    def __init__(self, message: str = "feed unreachable") -> None:
        super().__init__(message, provider="ics")
        self.code = "unreachable"


@dataclass(frozen=True, slots=True)
class FetchResult:
    status: int
    body: bytes
    etag: str | None
    last_modified: str | None

    @property
    def not_modified(self) -> bool:
        return self.status == 304


def _from_unsafe(exc: UnsafeUrlError) -> FeedError:
    messages = {
        "blocked_address": "feed blocked: the address is on a private or reserved network",
        "https_required": "feed blocked: the link must use https",
        "unresolvable": "feed unreachable: the host name could not be resolved",
    }
    return FeedError(exc.code, messages.get(exc.code, "feed blocked: the link is not valid"))


async def _read_capped(response: httpx.Response, limit: int) -> bytes:
    declared = response.headers.get("Content-Length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise FeedError("too_large", "feed too large")
    chunks: list[bytes] = []
    total = 0
    async for chunk in response.aiter_bytes():
        total += len(chunk)
        if total > limit:
            raise FeedError("too_large", "feed too large")
        chunks.append(chunk)
    return b"".join(chunks)


async def fetch_feed(
    url: str,
    *,
    etag: str | None = None,
    last_modified: str | None = None,
    settings: Settings | None = None,
) -> FetchResult:
    """Fetch ``url`` (conditionally when validators are given). See the module docstring."""
    cfg = settings or get_settings()
    try:
        async with asyncio.timeout(cfg.ics_timeout_seconds * 2):
            return await _fetch(url, etag, last_modified, cfg)
    except TimeoutError as exc:
        raise FeedUnreachableError("feed unreachable: timed out") from exc


async def _fetch(
    url: str, etag: str | None, last_modified: str | None, cfg: Settings
) -> FetchResult:
    current = url
    async with new_client(timeout=cfg.ics_timeout_seconds) as client:
        for _hop in range(MAX_REDIRECTS + 1):
            try:
                target: ValidatedTarget = await validate_target(current, cfg)
            except UnsafeUrlError as exc:
                raise _from_unsafe(exc) from exc
            headers = {
                "Host": target.host_header,
                "User-Agent": USER_AGENT,
                "Accept": "text/calendar, text/plain;q=0.8, */*;q=0.1",
            }
            if etag:
                headers["If-None-Match"] = etag
            if last_modified:
                headers["If-Modified-Since"] = last_modified
            try:
                async with client.stream(
                    "GET",
                    target.pinned_url,
                    headers=headers,
                    extensions={"sni_hostname": target.host},
                ) as response:
                    status = response.status_code
                    if status in (301, 302, 303, 307, 308):
                        location = response.headers.get("Location")
                        if not location:
                            raise FeedError("bad_redirect", "feed redirected without a target")
                        current = urljoin(current, location)
                        continue
                    if status == 304:
                        return FetchResult(304, b"", etag, last_modified)
                    if status in (401, 403, 404, 410):
                        raise FeedError(
                            "rejected",
                            "feed link rejected: it may have been revoked or regenerated",
                        )
                    if status == 429 or status >= 500:
                        raise FeedUnreachableError(
                            f"feed unreachable: the host answered HTTP {status}"
                        )
                    if status != 200:
                        raise FeedError("bad_status", f"feed rejected: HTTP {status}")
                    content_type = (
                        response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
                    )
                    if content_type and not content_type.startswith(_OK_TYPES):
                        raise FeedError(
                            "not_calendar", "feed is not a calendar (unexpected content type)"
                        )
                    body = await _read_capped(response, cfg.ics_max_bytes)
                    return FetchResult(
                        200,
                        body,
                        response.headers.get("ETag"),
                        response.headers.get("Last-Modified"),
                    )
            except httpx.HTTPError as exc:
                raise FeedUnreachableError() from exc
        raise FeedError("too_many_redirects", "feed redirected too many times")
