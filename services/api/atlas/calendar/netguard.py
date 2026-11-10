"""Outbound-request guard for user-supplied feed URLs (SSRF, SECURITY.md T24, ADR-0071).

An ICS feed URL is chosen by the user, so Atlas would otherwise fetch an attacker-influenced address
from inside the operator's network (cloud metadata, the database, the router). This module is the
one
place that decides whether a URL may be fetched:

- ``https`` only (``http`` only with ``ICS_ALLOW_HTTP``), no credentials in the URL, a host name or
  address, and a sane port;
- the host is **resolved here** and *every* address must be globally routable - private (RFC 1918),
  loopback, link-local (including the ``169.254.169.254`` metadata address), carrier-grade NAT,
  unique-local and multicast/reserved ranges are refused, IPv4-mapped IPv6 is unwrapped first and a
  NAT64 prefix is checked against the embedded IPv4;
- the request then connects to the **validated address** (the caller pins it), so a DNS answer that
  changes between the check and the connect (rebinding) cannot redirect the request;
- redirects are followed manually by the caller and every hop goes through the same check.

``ICS_ALLOW_PRIVATE_HOSTS`` disables only the address test, exists for the development fixture
server
and is refused in production by ``Settings.validate_for_runtime``.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from dataclasses import dataclass
from urllib.parse import SplitResult, urlsplit

from ..config import Settings, get_settings

MAX_URL_LENGTH = 2048

_NAT64 = ipaddress.ip_network("64:ff9b::/96")


class UnsafeUrlError(Exception):
    """The URL must not be fetched. ``code`` is stable and content-free."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class ValidatedTarget:
    """A URL that passed validation, with the address the connection must use."""

    url: str
    scheme: str
    host: str
    port: int
    address: str
    request_target: str

    @property
    def host_header(self) -> str:
        default = 443 if self.scheme == "https" else 80
        return self.host if self.port == default else f"{self.host}:{self.port}"

    @property
    def pinned_url(self) -> str:
        """The URL with the validated IP as host (the original host goes in ``Host``/SNI)."""
        literal = f"[{self.address}]" if ":" in self.address else self.address
        return f"{self.scheme}://{literal}:{self.port}{self.request_target}"


def is_global_address(raw: str) -> bool:
    """Whether ``raw`` is a publicly routable IP address (the only kind a feed may live on)."""
    try:
        address = ipaddress.ip_address(raw)
    except ValueError:
        return False
    if isinstance(address, ipaddress.IPv6Address):
        if address.ipv4_mapped is not None:
            address = address.ipv4_mapped
        elif address in _NAT64:
            embedded = ipaddress.IPv4Address(int(address) & 0xFFFFFFFF)
            return is_global_address(str(embedded))
        elif address.sixtofour is not None and not is_global_address(str(address.sixtofour)):
            return False
    return bool(address.is_global) and not address.is_multicast


def parse_feed_url(url: str, settings: Settings | None = None) -> SplitResult:
    """Syntactic validation only (no DNS): scheme, credentials, host, port, length."""
    cfg = settings or get_settings()
    candidate = url.strip()
    if not candidate or len(candidate) > MAX_URL_LENGTH:
        raise UnsafeUrlError("invalid_url", "the feed URL is empty or too long")
    if any(ord(ch) < 33 or ord(ch) == 127 for ch in candidate):
        raise UnsafeUrlError(
            "invalid_url", "the feed URL contains whitespace or control characters"
        )
    # Calendar apps hand out ``webcal://``: it is https in practice.
    if candidate.lower().startswith("webcal://"):
        candidate = "https://" + candidate[len("webcal://") :]
    try:
        parts = urlsplit(candidate)
        port = parts.port
    except ValueError as exc:
        raise UnsafeUrlError("invalid_url", "the feed URL is not valid") from exc
    scheme = parts.scheme.lower()
    if scheme not in {"https", "http"}:
        raise UnsafeUrlError("invalid_url", "the feed URL must start with https://")
    if scheme == "http" and not cfg.ics_allow_http:
        raise UnsafeUrlError("https_required", "the feed URL must use https://")
    if not parts.hostname:
        raise UnsafeUrlError("invalid_url", "the feed URL has no host")
    if parts.username is not None or parts.password is not None:
        raise UnsafeUrlError("invalid_url", "the feed URL must not contain a user name or password")
    if port == 0:
        raise UnsafeUrlError("invalid_url", "the feed URL has an invalid port")
    return parts


async def resolve_addresses(host: str, port: int) -> list[str]:
    """Every address ``host`` resolves to (a literal address resolves to itself)."""
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(
            host, port, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP
        )
    except OSError as exc:
        raise UnsafeUrlError("unresolvable", "the feed host could not be resolved") from exc
    addresses = []
    for info in infos:
        address = str(info[4][0]).split("%", 1)[0]
        if address not in addresses:
            addresses.append(address)
    if not addresses:
        raise UnsafeUrlError("unresolvable", "the feed host could not be resolved")
    return addresses


async def validate_target(url: str, settings: Settings | None = None) -> ValidatedTarget:
    """Validate ``url`` and resolve it to a safe address (raises :class:`UnsafeUrlError`)."""
    cfg = settings or get_settings()
    parts = parse_feed_url(url, cfg)
    scheme = parts.scheme.lower()
    host = parts.hostname or ""
    port = parts.port or (443 if scheme == "https" else 80)
    addresses = await resolve_addresses(host, port)
    if not cfg.ics_allow_private_hosts:
        bad = [a for a in addresses if not is_global_address(a)]
        if bad:
            raise UnsafeUrlError(
                "blocked_address", "the feed host is on a private or reserved network address"
            )
    path = parts.path or "/"
    target = path + (f"?{parts.query}" if parts.query else "")
    return ValidatedTarget(
        url=parts._replace(scheme=scheme).geturl(),
        scheme=scheme,
        host=host,
        port=port,
        address=addresses[0],
        request_target=target,
    )


def mask_feed_url(url: str) -> str:
    """What the UI may show of a secret feed URL: scheme and host, the rest masked."""
    parts = urlsplit(url.strip().replace("webcal://", "https://", 1))
    host = parts.hostname or "feed"
    if parts.port:
        host = f"{host}:{parts.port}"
    return f"{parts.scheme or 'https'}://{host}/••••••••"
