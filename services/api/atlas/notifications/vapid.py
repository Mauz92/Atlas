"""Web Push VAPID configuration (M8-02).

Web Push requires an application-server key pair (VAPID, RFC 8292) so a push service can attribute
a push to this Atlas instance. The **private** key signs the delivery request and must never leave
the server; the **public** key is handed to the browser so it can form the subscription. Both are
configuration — provided through the environment like the other secrets (``AGENTS.md`` §11) and
never committed — and the *subject* (a ``mailto:`` or ``https:`` contact per RFC 8292 §2.1) is what
the push service can use to contact the operator.

This module holds only the pure rules: how the settings become a usable (or absent) configuration.
The transport that consumes it lives in :mod:`atlas.reminders.push`. When any of the three values is
missing the whole feature is **disabled** (a single, explicit state) so the rest of the system can
degrade cleanly instead of attempting a send it cannot sign (``AGENTS.md`` §16).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


class VapidSettings(Protocol):
    """The settings attributes this module reads (kept structural to avoid an import cycle)."""

    vapid_public_key: str
    vapid_private_key: str
    vapid_subject: str


@dataclass(frozen=True, slots=True)
class VapidConfig:
    """A fully configured VAPID key pair plus the RFC 8292 ``sub`` contact.

    ``private_key`` is a secret: it is only ever handed to the push library to sign a request, never
    returned by an API, serialised into a client bundle or written to a log (``AGENTS.md`` §11).
    """

    public_key: str
    private_key: str
    subject: str


def _clean(value: str | None) -> str:
    return (value or "").strip()


def build_vapid_config(settings: VapidSettings) -> VapidConfig | None:
    """Build the VAPID configuration, or ``None`` when the feature is not configured.

    Web Push is enabled only when all three values are present: without a public key the browser
    cannot subscribe, without a private key the server cannot sign a push and without a subject the
    push service has no contact for the sender. A partial configuration is treated as disabled — the
    single, explicit "off" state — rather than attempting a delivery that must fail.
    """
    public_key = _clean(settings.vapid_public_key)
    private_key = _clean(settings.vapid_private_key)
    subject = _clean(settings.vapid_subject)
    if not (public_key and private_key and subject):
        return None
    return VapidConfig(public_key=public_key, private_key=private_key, subject=subject)


def is_configured(settings: VapidSettings) -> bool:
    """Whether Web Push is configured (all three VAPID values present)."""
    return build_vapid_config(settings) is not None


def missing_vapid_fields(settings: VapidSettings) -> list[str]:
    """The names of the VAPID settings that are unset, for an operator-facing diagnostic.

    Never includes a value — only the setting names (``AGENTS.md`` §11).
    """
    missing: list[str] = []
    if not _clean(settings.vapid_public_key):
        missing.append("vapid_public_key")
    if not _clean(settings.vapid_private_key):
        missing.append("vapid_private_key")
    if not _clean(settings.vapid_subject):
        missing.append("vapid_subject")
    return missing


__all__ = [
    "VapidConfig",
    "build_vapid_config",
    "is_configured",
    "missing_vapid_fields",
]
