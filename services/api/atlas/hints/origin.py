"""Validation of a device-supplied hint endpoint against the operator's gateway (SSRF control).

The server makes an outbound request to a URL a device supplied. The control is not a block-list of
private ranges (which would break the main use, a self-hosted ntfy on a LAN or tailnet) but an
allow-list of exactly one origin that only the operator can set: a registered endpoint is accepted
only when its scheme, host and port equal the configured gateway's and its path is a plain topic
path. Everything else - another host or port, userinfo, a query or fragment, an IP literal that is
not the configured host, dot segments, an over-long URL - is refused before anything is stored or
requested. Redirects are never followed (see :mod:`atlas.hints.ntfy`).
"""

from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass
from urllib.parse import SplitResult, urlsplit

MAX_ENDPOINT_LENGTH = 512
#: ntfy's UnifiedPush topics are ``up`` plus random characters; other gateways use a similar shape
TOPIC_PATH = re.compile(r"^/up[A-Za-z0-9_-]{8,64}$")
_LOOPBACK_NAMES = {"localhost"}


class InvalidHintEndpointError(ValueError):
    """The endpoint is not acceptable; the message is safe to show (it never echoes the URL)."""


class InvalidGatewayConfigError(ValueError):
    """``SYNC_HINT_GATEWAY_URL`` is not a usable origin."""


@dataclass(frozen=True, slots=True)
class GatewayOrigin:
    scheme: str
    host: str
    port: int

    @property
    def base(self) -> str:
        host = f"[{self.host}]" if ":" in self.host else self.host
        default = 443 if self.scheme == "https" else 80
        return f"{self.scheme}://{host}" + ("" if self.port == default else f":{self.port}")


def _is_loopback(host: str) -> bool:
    if host in _LOOPBACK_NAMES:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _port(parts: SplitResult) -> int | None:
    try:
        port = parts.port
    except ValueError:
        return None
    return port or (443 if parts.scheme == "https" else 80 if parts.scheme == "http" else None)


def parse_gateway_origin(
    url: str, *, production: bool, allow_insecure_http: bool = False
) -> GatewayOrigin:
    """The operator's gateway origin, or :class:`InvalidGatewayConfigError`.

    ``https`` always. ``http`` only with ``allow_insecure_http`` (a LAN/tailnet gateway the operator
    chose) or, outside production, for a loopback host.
    """
    parts = urlsplit(url.strip())
    if parts.scheme not in {"https", "http"} or not parts.hostname:
        raise InvalidGatewayConfigError("gateway URL must be an http(s) origin")
    if (
        parts.username
        or parts.password
        or parts.query
        or parts.fragment
        or parts.path not in {"", "/"}
    ):
        raise InvalidGatewayConfigError(
            "gateway URL must be an origin only (no path or credentials)"
        )
    host = parts.hostname.lower()
    if parts.scheme == "http" and not (
        allow_insecure_http or (not production and _is_loopback(host))
    ):
        raise InvalidGatewayConfigError(
            "plain http is refused (set SYNC_HINT_ALLOW_INSECURE_HTTP=true for a LAN or tailnet "
            "gateway, or use https)"
        )
    port = _port(parts)
    if port is None:
        raise InvalidGatewayConfigError("gateway URL has an invalid port")
    return GatewayOrigin(parts.scheme, host, port)


def validate_endpoint(endpoint: str, origin: GatewayOrigin) -> str:
    """Return ``endpoint`` normalised when it is a topic URL on ``origin``, else raise."""
    if not endpoint or len(endpoint) > MAX_ENDPOINT_LENGTH or not endpoint.isascii():
        raise InvalidHintEndpointError("endpoint is empty, too long or not ASCII")
    if any(c in endpoint for c in " \\\t\r\n") or "%" in endpoint:
        raise InvalidHintEndpointError("endpoint contains characters that are not allowed")
    try:
        parts = urlsplit(endpoint)
    except ValueError as exc:
        raise InvalidHintEndpointError("endpoint is not a URL") from exc
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        raise InvalidHintEndpointError("endpoint must not carry credentials")
    if parts.query or parts.fragment:
        raise InvalidHintEndpointError("endpoint must not carry a query or fragment")
    host = (parts.hostname or "").lower()
    if (parts.scheme, host, _port(parts)) != (origin.scheme, origin.host, origin.port):
        raise InvalidHintEndpointError("endpoint is not on the configured gateway")
    if not TOPIC_PATH.fullmatch(parts.path):
        raise InvalidHintEndpointError("endpoint path is not a topic path")
    return f"{origin.base}{parts.path}"
