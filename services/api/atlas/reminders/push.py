"""Web Push transport (M8-02).

:class:`PushSender` is the real :class:`~atlas.reminders.notifier.Notifier` for Web Push. It signs
the request and sends it with the maintained
`pywebpush <https://github.com/web-push-libs/pywebpush>`_ library
(``AGENTS.md`` §7.5 — a standards implementation, **no custom cryptography**): the library performs
the ECE content encryption and the RFC 8292 VAPID request signing.

Behaviour:

- It targets only a **web** destination that carries a subscription (:class:`PushSubscription`, put
  on the message by the delivery layer from the M8-03 registry). A native token or an untargeted
  reminder has no web subscription, so the send is delegated to the fallback notifier (the log
  channel) — a native transport is M8-04, and a reminder is never dropped merely because this
  transport does not own it.
- The push service reporting a destination **gone** (HTTP ``404``/``410``) is returned as an
  ``invalid_destinations`` entry, exactly the signal M8-03 uses to disable the row so it is never
  retried. Any other failure (a ``5xx``, a timeout, a network error) raises
  :class:`~atlas.reminders.notifier.NotifierError` so the durable delivery job retries with backoff.
- When VAPID is not configured the whole feature is off: the sender degrades to the fallback channel
  and **never** raises, so a missing key pair cannot wedge reminder delivery (``AGENTS.md`` §16).

The library call is synchronous, so it is run off the event loop with :func:`asyncio.to_thread`. The
transport is injectable, which lets the unit/integration tests exercise success and an invalid
destination deterministically without contacting a real push service (``AGENTS.md`` §13).
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable
from typing import Any

from pywebpush import WebPushException, webpush

from ..config import Settings, get_settings
from ..notifications.vapid import VapidConfig, build_vapid_config, missing_vapid_fields
from .notifier import (
    DeliveryResult,
    LoggingNotifier,
    Notifier,
    NotifierError,
    ReminderMessage,
    set_notifier,
)

logger = logging.getLogger("atlas.reminders")

#: HTTP statuses a push service returns when the subscription is no longer usable. Both mean the
#: destination should be disabled (M8-03), not retried.
INVALID_DESTINATION_STATUSES: frozenset[int] = frozenset({404, 410})

#: A Web Push library call, matching ``pywebpush.webpush``'s signature (keyword-only in practice).
PushTransport = Callable[..., Any]


class PushSender:
    """A ``Notifier`` that delivers to Web Push subscriptions via ``pywebpush``."""

    channel = "webpush"

    def __init__(
        self,
        config: VapidConfig | None,
        *,
        transport: PushTransport = webpush,
        fallback: Notifier | None = None,
        ttl: int = 60 * 60 * 24,
        timeout: float = 10.0,
    ) -> None:
        self._config = config
        self._transport = transport
        self._fallback = fallback or LoggingNotifier()
        self._ttl = ttl
        self._timeout = timeout

    @property
    def enabled(self) -> bool:
        """Whether VAPID is configured (the feature is otherwise cleanly disabled)."""
        return self._config is not None

    @classmethod
    def from_settings(
        cls,
        settings: Settings | None = None,
        *,
        transport: PushTransport = webpush,
        fallback: Notifier | None = None,
    ) -> PushSender:
        """Build a sender from the application settings (``None`` config disables Web Push)."""
        return cls(
            build_vapid_config(settings or get_settings()),
            transport=transport,
            fallback=fallback,
        )

    async def send(self, message: ReminderMessage) -> DeliveryResult:
        """Send ``message`` to its web subscription, or degrade to the fallback channel.

        A malformed response from the push service must never leak the endpoint or keys into a log
        line, so only the HTTP status is recorded (``AGENTS.md`` §11).
        """
        subscription = message.subscription
        if self._config is None or subscription is None:
            return await self._fallback.send(message)

        payload = json.dumps(_payload_for(message))
        try:
            await asyncio.to_thread(
                self._transport,
                subscription_info=subscription.to_info(),
                data=payload,
                vapid_private_key=self._config.private_key,
                vapid_claims={"sub": self._config.subject},
                ttl=self._ttl,
                timeout=self._timeout,
            )
        except WebPushException as exc:
            status = exc.status_code
            if status in INVALID_DESTINATION_STATUSES:
                logger.info("web push destination gone", extra={"status": status})
                return DeliveryResult(
                    delivered=False,
                    channel=self.channel,
                    detail=f"destination is gone ({status})",
                    invalid_destinations=(subscription.endpoint,),
                )
            raise NotifierError(f"web push failed (status {status})") from exc
        except Exception as exc:  # a network error, a bad key: retryable, never crash the worker
            raise NotifierError("web push transport error") from exc

        return DeliveryResult(delivered=True, channel=self.channel)


def _payload_for(message: ReminderMessage) -> dict[str, Any]:
    """The JSON body the service worker reads from the ``push`` event.

    ``dedupe_key`` is carried so the client can drop a duplicate observed across the crash window
    between a push being sent and the delivery transaction committing
    (``ReminderMessage.dedupe_key``).
    """
    return {
        "title": message.title,
        "body": message.body,
        "data": {
            "reminder_id": str(message.reminder_id),
            "entity_type": message.entity_type,
            "entity_id": str(message.entity_id),
            "dedupe_key": message.dedupe_key,
        },
    }


def _build_sender(
    settings: Settings, *, transport: PushTransport = webpush, fallback: Notifier | None = None
) -> PushSender:
    """Construct the sender from settings (kept separate so tests can inject a transport)."""
    return PushSender.from_settings(settings, transport=transport, fallback=fallback)


def configure_notifier(
    settings: Settings | None = None,
    *,
    transport: PushTransport = webpush,
) -> PushSender:
    """Install the Web Push sender as the process notifier and return it.

    Called once by the worker entry point. Replacing the default logging notifier means a reminder
    is attempted over Web Push; the sender itself falls back to logging when VAPID is unconfigured
    or a destination is not a web subscription, so behaviour degrades cleanly rather than breaking.
    """
    resolved = settings or get_settings()
    sender = _build_sender(resolved, transport=transport)
    set_notifier(sender)
    if sender.enabled:
        logger.info("web push enabled")
    else:
        missing = ",".join(missing_vapid_fields(resolved))
        logger.info("web push disabled", extra={"missing_settings": missing})
    return sender


__all__ = [
    "INVALID_DESTINATION_STATUSES",
    "PushSender",
    "PushTransport",
    "configure_notifier",
]
