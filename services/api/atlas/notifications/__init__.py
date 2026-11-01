"""Push destination registry + invalidation (M8-03).

A user registers their push destinations (a Web Push subscription, or an ``android``/``ios`` push
token); the backend keeps one row per ``(user, channel, endpoint)`` and **prunes** a destination a
delivery reports invalid/expired (e.g. a Web Push ``404``/``410``) so it is never retried. This is
the storage M8-02 (Web Push) and M8-04 (native push) build on; the transports themselves are out of
scope here.

Public surface: the pure rules (:mod:`atlas.notifications.registry`) and the user-scoped service
(:class:`~atlas.notifications.service.NotificationRegistryService`).
"""

from .registry import (
    KNOWN_CHANNELS,
    MAX_ENDPOINT_LENGTH,
    MAX_KEY_LENGTH,
    MAX_PLATFORM_LENGTH,
    NATIVE_CHANNELS,
    WEB_CHANNEL,
    DeviceRegistration,
    InvalidDeviceError,
    build_destination_key,
    build_registration,
    clean_reported_endpoints,
    device_is_active,
    is_web,
    normalise_channel,
)
from .service import NotificationRegistryService
from .vapid import VapidConfig, build_vapid_config, is_configured, missing_vapid_fields

__all__ = [
    "KNOWN_CHANNELS",
    "MAX_ENDPOINT_LENGTH",
    "MAX_KEY_LENGTH",
    "MAX_PLATFORM_LENGTH",
    "NATIVE_CHANNELS",
    "WEB_CHANNEL",
    "DeviceRegistration",
    "InvalidDeviceError",
    "NotificationRegistryService",
    "VapidConfig",
    "build_destination_key",
    "build_registration",
    "build_vapid_config",
    "clean_reported_endpoints",
    "device_is_active",
    "is_configured",
    "is_web",
    "missing_vapid_fields",
    "normalise_channel",
]
