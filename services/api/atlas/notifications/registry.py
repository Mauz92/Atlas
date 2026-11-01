"""Pure destination-registry rules (M8-03).

The registry stores one row per ``(user, channel, endpoint)``. Everything that can be decided
without a database — what a known channel is, what a destination must look like, what makes a row
active, and what a delivery's "this endpoint is dead" signal means — lives here, so the service and
the API stay thin (``AGENTS.md`` §6/§16).

No secret material is ever included in an error message (``AGENTS.md`` §11): a rejected destination
is described by its channel and shape, never by the endpoint, ``p256dh`` or ``auth`` value.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

from ..models.notification import PushChannel

#: Channels a destination may belong to, as persisted strings.
KNOWN_CHANNELS: frozenset[str] = frozenset(channel.value for channel in PushChannel)

#: Web Push subscriptions carry client keys; the native channels carry only the token.
WEB_CHANNEL = PushChannel.WEB.value
NATIVE_CHANNELS: frozenset[str] = frozenset({PushChannel.ANDROID.value, PushChannel.IOS.value})

#: Bounds enforced at the boundary (the stored columns are sized to match).
MAX_ENDPOINT_LENGTH = 1024
MAX_KEY_LENGTH = 256
MAX_PLATFORM_LENGTH = 128


class InvalidDeviceError(ValueError):
    """A destination registration that cannot be stored.

    The message never contains the endpoint, ``p256dh`` or ``auth`` value — only a description of
    what was wrong (``AGENTS.md`` §11).
    """


@dataclass(frozen=True, slots=True)
class DeviceRegistration:
    """A validated, normalised destination registration."""

    channel: str
    endpoint: str
    p256dh: str | None = None
    auth: str | None = None
    platform: str | None = None

    @property
    def key(self) -> tuple[str, str]:
        """The ``(channel, endpoint)`` identity of a destination within a user."""
        return (self.channel, self.endpoint)


def normalise_channel(channel: str) -> str:
    """Trim/lower-case a channel and require it to be known."""
    value = (channel or "").strip().lower()
    if value not in KNOWN_CHANNELS:
        raise InvalidDeviceError("channel must be one of: " + ", ".join(sorted(KNOWN_CHANNELS)))
    return value


def is_web(channel: str) -> bool:
    """Whether ``channel`` is the Web Push channel (which carries client keys)."""
    return channel == WEB_CHANNEL


def _clean_optional(
    value: str | None, *, field: str, max_length: int, required: bool
) -> str | None:
    """Strip an optional text field; enforce required-ness and the length bound."""
    text = (value or "").strip()
    if not text:
        if required:
            raise InvalidDeviceError(f"{field} is required for this channel")
        return None
    if len(text) > max_length:
        raise InvalidDeviceError(f"{field} must be at most {max_length} characters")
    return text


def build_destination_key(channel: str, endpoint: str) -> DeviceRegistration:
    """Validate and normalise just the ``(channel, endpoint)`` identity of a destination.

    Used when the destination is only being addressed (unregister/disable), so the channel-specific
    keys are neither required nor supplied.
    """
    normalised_channel = normalise_channel(channel)
    clean_endpoint = _clean_optional(
        endpoint, field="endpoint", max_length=MAX_ENDPOINT_LENGTH, required=True
    )
    assert clean_endpoint is not None  # ``required=True`` guarantees this
    return DeviceRegistration(channel=normalised_channel, endpoint=clean_endpoint)


def build_registration(
    channel: str,
    endpoint: str,
    *,
    p256dh: str | None = None,
    auth: str | None = None,
    platform: str | None = None,
) -> DeviceRegistration:
    """Validate and normalise a registration, or raise :class:`InvalidDeviceError`.

    A ``web`` destination **requires** ``p256dh`` and ``auth``; a native destination must **not**
    supply them, so a mis-shaped registration is rejected at the boundary rather than stored
    half-formed.
    """
    normalised_channel = normalise_channel(channel)
    clean_endpoint = _clean_optional(
        endpoint, field="endpoint", max_length=MAX_ENDPOINT_LENGTH, required=True
    )
    assert clean_endpoint is not None  # ``required=True`` guarantees this
    clean_platform = _clean_optional(
        platform, field="platform", max_length=MAX_PLATFORM_LENGTH, required=False
    )
    if is_web(normalised_channel):
        clean_p256dh = _clean_optional(
            p256dh, field="p256dh", max_length=MAX_KEY_LENGTH, required=True
        )
        clean_auth = _clean_optional(auth, field="auth", max_length=MAX_KEY_LENGTH, required=True)
    else:
        if (p256dh or "").strip() or (auth or "").strip():
            raise InvalidDeviceError("p256dh/auth are only valid for the web channel")
        clean_p256dh = None
        clean_auth = None
    return DeviceRegistration(
        channel=normalised_channel,
        endpoint=clean_endpoint,
        p256dh=clean_p256dh,
        auth=clean_auth,
        platform=clean_platform,
    )


def device_is_active(*, disabled_at: object | None) -> bool:
    """Whether a destination is still targeted by deliveries (never disabled/invalidated)."""
    return disabled_at is None


def clean_reported_endpoints(endpoints: Iterable[str]) -> list[str]:
    """Normalise the endpoints a delivery reported invalid.

    Trims, drops blanks, collapses duplicates and preserves first-seen order, so a transport that
    reports the same dead endpoint twice disables it once.
    """
    seen: dict[str, None] = {}
    for raw in endpoints:
        value = (raw or "").strip()
        if value:
            seen.setdefault(value, None)
    return list(seen)


__all__ = [
    "KNOWN_CHANNELS",
    "MAX_ENDPOINT_LENGTH",
    "MAX_KEY_LENGTH",
    "MAX_PLATFORM_LENGTH",
    "NATIVE_CHANNELS",
    "WEB_CHANNEL",
    "DeviceRegistration",
    "InvalidDeviceError",
    "build_destination_key",
    "build_registration",
    "clean_reported_endpoints",
    "device_is_active",
    "is_web",
    "normalise_channel",
]
