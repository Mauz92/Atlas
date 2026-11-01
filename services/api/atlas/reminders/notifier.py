"""Notification delivery abstraction (M8-01).

A reminder is *scheduled* by :mod:`atlas.reminders.service` and *delivered* through a small
:class:`Notifier` interface. Real transports (Web Push, M8-02; native push, M8-04) plug in behind
this interface; the default is a logging notifier and :class:`RecordingNotifier` is a fake for
tests that records the messages it was handed. Keeping delivery behind an interface means the
scheduler and its idempotency can be tested without a push service, and no provider SDK leaks into
the reminder logic (``AGENTS.md`` §7.3).
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Protocol, runtime_checkable

logger = logging.getLogger("atlas.reminders")


class NotifierError(RuntimeError):
    """A transport failed to accept a notification; the delivery job should retry."""


@dataclass(frozen=True, slots=True)
class PushSubscription:
    """A Web Push subscription's client keys (M8-02).

    ``endpoint`` is the push-service URL and ``p256dh``/``auth`` are the client's public key and
    auth secret, exactly as the browser supplies them. Together they authorise a push to one device,
    so they are secret-ish: only a transport receives them and they are never logged (``AGENTS.md``
    §11).
    """

    endpoint: str
    p256dh: str
    auth: str

    def to_info(self) -> dict[str, object]:
        """Render the ``subscription_info`` mapping a Web Push library expects."""
        return {"endpoint": self.endpoint, "keys": {"p256dh": self.p256dh, "auth": self.auth}}


@dataclass(frozen=True, slots=True)
class ReminderMessage:
    """One notification to hand to a transport.

    ``dedupe_key`` is stable for the lifetime of a reminder, so a transport or client that observes
    it twice (for example across the crash window between a push being sent and the transaction that
    records it committing) can drop the duplicate.

    ``destination`` names the registered destination this send targets — a Web Push endpoint or a
    native push token (M8-03). It is ``None`` for the untargeted default channel (a user with no
    registered destination).

    ``subscription`` carries the full Web Push subscription (endpoint + client keys) when the
    destination is a web subscription (M8-02), so the transport never needs to look it up. It is
    ``None`` for a native token or the untargeted fallback.
    """

    reminder_id: uuid.UUID
    user_id: uuid.UUID
    entity_type: str
    entity_id: uuid.UUID
    title: str
    body: str
    fire_at: datetime
    due_at: datetime | None
    time_zone: str | None
    destination: str | None = None
    subscription: PushSubscription | None = None

    @property
    def dedupe_key(self) -> str:
        return f"reminder:{self.reminder_id}"


@dataclass(frozen=True, slots=True)
class DeliveryResult:
    """The outcome of one delivery attempt.

    ``invalid_destinations`` lets a transport report that a destination is **invalid/expired** — a
    Web Push ``404``/``410`` (M8-02) or an unregistered native token (M8-04). The delivery handler
    disables exactly those rows so they are not retried (M8-03 invalidation). An empty tuple (the
    default) means the transport observed nothing dead.
    """

    delivered: bool
    channel: str
    detail: str | None = None
    invalid_destinations: tuple[str, ...] = ()


@runtime_checkable
class Notifier(Protocol):
    """A delivery channel for reminders."""

    async def send(self, message: ReminderMessage) -> DeliveryResult: ...


class LoggingNotifier:
    """The default notifier: records the notification in the log and reports success."""

    channel = "log"

    async def send(self, message: ReminderMessage) -> DeliveryResult:
        logger.info(
            "reminder notification",
            extra={
                "reminder_id": str(message.reminder_id),
                "user_id": str(message.user_id),
                "entity_type": message.entity_type,
                "entity_id": str(message.entity_id),
                "fire_at": message.fire_at.isoformat(),
                "dedupe_key": message.dedupe_key,
            },
        )
        return DeliveryResult(delivered=True, channel=self.channel)


@dataclass
class RecordingNotifier:
    """A fake notifier for tests: records messages, optionally failing the first ``fail_times``.

    ``invalid_destinations`` lets a test simulate a transport that found a destination dead (a Web
    Push ``410``): every result reports those endpoints so the delivery handler can disable them
    (M8-03).
    """

    channel: str = "recording"
    fail_times: int = 0
    messages: list[ReminderMessage] = field(default_factory=list)
    attempts: int = 0
    invalid_destinations: tuple[str, ...] = ()

    async def send(self, message: ReminderMessage) -> DeliveryResult:
        self.attempts += 1
        if self.attempts <= self.fail_times:
            raise NotifierError("simulated transport failure")
        self.messages.append(message)
        return DeliveryResult(
            delivered=True, channel=self.channel, invalid_destinations=self.invalid_destinations
        )


_default_notifier: Notifier = LoggingNotifier()


def get_notifier() -> Notifier:
    """The notifier the delivery handler uses."""
    return _default_notifier


def set_notifier(notifier: Notifier) -> None:
    """Install a notifier (used by the app wiring and by tests)."""
    global _default_notifier
    _default_notifier = notifier


def reset_notifier() -> None:
    """Restore the default logging notifier."""
    global _default_notifier
    _default_notifier = LoggingNotifier()


__all__ = [
    "DeliveryResult",
    "LoggingNotifier",
    "Notifier",
    "NotifierError",
    "PushSubscription",
    "RecordingNotifier",
    "ReminderMessage",
    "get_notifier",
    "reset_notifier",
    "set_notifier",
]
