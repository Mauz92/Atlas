"""The Web Push sender, driven by a fake transport (M8-02).

The transport (``pywebpush.webpush``) is injectable, so these tests exercise the sender's real logic
— success, an invalid destination, a retryable failure and the disabled/no-subscription paths —
deterministically, without contacting a push service (``AGENTS.md`` §13). No custom cryptography is
tested here because none exists: the maintained library performs the encryption and signing.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest
from pywebpush import WebPushException

from atlas.notifications.vapid import VapidConfig
from atlas.reminders.notifier import (
    LoggingNotifier,
    NotifierError,
    PushSubscription,
    ReminderMessage,
    get_notifier,
    reset_notifier,
)
from atlas.reminders.push import (
    INVALID_DESTINATION_STATUSES,
    PushSender,
    configure_notifier,
)

CONFIG = VapidConfig(
    public_key="BClientVisiblePublicKey", private_key="PRIVATE-KEY", subject="mailto:ops@atlas.test"
)
SUBSCRIPTION = PushSubscription(endpoint="https://push.example/sub/abc", p256dh="BPUB", auth="AUTH")


@dataclass
class FakeResponse:
    """Just enough of a ``requests``/``aiohttp`` response for ``WebPushException``."""

    status_code: int
    headers: dict[str, str] = field(default_factory=dict)
    text: str = ""
    reason: str = ""


class RecordingTransport:
    """Records the calls it is given; optionally raises the supplied exceptions in order."""

    def __init__(self, *, raises: list[Exception] | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self._raises = list(raises or [])

    def __call__(self, **kwargs: Any) -> None:
        self.calls.append(kwargs)
        if self._raises:
            raise self._raises.pop(0)


def message(
    *, subscription: PushSubscription | None = SUBSCRIPTION, destination: str | None = None
) -> ReminderMessage:
    resolved = destination
    if resolved is None and subscription is not None:
        resolved = subscription.endpoint
    return ReminderMessage(
        reminder_id=uuid.uuid4(),
        user_id=uuid.uuid4(),
        entity_type="task",
        entity_id=uuid.uuid4(),
        title="Water the plants",
        body='Task "Water the plants" is due.',
        fire_at=datetime(2026, 6, 10, 7, 0, tzinfo=UTC),
        due_at=datetime(2026, 6, 10, 15, 0, tzinfo=UTC),
        time_zone="Europe/Amsterdam",
        destination=resolved,
        subscription=subscription,
    )


async def test_a_configured_sender_pushes_to_the_subscription() -> None:
    transport = RecordingTransport()
    sender = PushSender(CONFIG, transport=transport)

    result = await sender.send(message())

    assert result.delivered is True
    assert result.channel == "webpush"
    assert result.invalid_destinations == ()
    assert sender.enabled is True

    (call,) = transport.calls
    assert call["subscription_info"] == {
        "endpoint": SUBSCRIPTION.endpoint,
        "keys": {"p256dh": "BPUB", "auth": "AUTH"},
    }
    assert call["vapid_private_key"] == CONFIG.private_key
    assert call["vapid_claims"] == {"sub": CONFIG.subject}
    payload = json.loads(call["data"])
    assert payload["title"] == "Water the plants"
    assert payload["data"]["dedupe_key"].startswith("reminder:")


@pytest.mark.parametrize("status", sorted(INVALID_DESTINATION_STATUSES))
async def test_a_gone_destination_is_reported_invalid(status: int) -> None:
    transport = RecordingTransport(
        raises=[WebPushException("gone", response=FakeResponse(status_code=status))]
    )
    sender = PushSender(CONFIG, transport=transport)

    result = await sender.send(message())

    assert result.delivered is False
    assert result.channel == "webpush"
    assert result.invalid_destinations == (SUBSCRIPTION.endpoint,)
    assert str(status) in (result.detail or "")


async def test_a_retryable_failure_raises_so_the_job_retries() -> None:
    transport = RecordingTransport(
        raises=[WebPushException("boom", response=FakeResponse(status_code=503))]
    )
    sender = PushSender(CONFIG, transport=transport)

    with pytest.raises(NotifierError):
        await sender.send(message())


async def test_a_transport_error_is_wrapped_as_retryable() -> None:
    transport = RecordingTransport(raises=[ConnectionError("network down")])
    sender = PushSender(CONFIG, transport=transport)

    with pytest.raises(NotifierError):
        await sender.send(message())


async def test_an_unconfigured_sender_degrades_to_the_fallback() -> None:
    transport = RecordingTransport()
    fallback = LoggingNotifier()
    sender = PushSender(None, transport=transport, fallback=fallback)

    result = await sender.send(message())

    assert sender.enabled is False
    assert result.delivered is True
    assert result.channel == "log"
    assert transport.calls == []  # nothing was pushed


async def test_a_non_web_destination_degrades_to_the_fallback() -> None:
    transport = RecordingTransport()
    sender = PushSender(CONFIG, transport=transport, fallback=LoggingNotifier())

    result = await sender.send(message(subscription=None, destination="native-token"))

    assert result.delivered is True
    assert result.channel == "log"
    assert transport.calls == []


def test_from_settings_reads_the_key_pair() -> None:
    configured = SimpleNamespace(
        vapid_public_key="pub", vapid_private_key="priv", vapid_subject="mailto:x@y.test"
    )
    sender = PushSender.from_settings(configured, transport=RecordingTransport())
    assert sender.enabled is True

    unconfigured = SimpleNamespace(vapid_public_key="", vapid_private_key="", vapid_subject="")
    assert PushSender.from_settings(unconfigured).enabled is False


def test_configure_notifier_installs_the_sender() -> None:
    settings = SimpleNamespace(
        vapid_public_key="pub", vapid_private_key="priv", vapid_subject="mailto:x@y.test"
    )
    try:
        sender = configure_notifier(settings, transport=RecordingTransport())
        assert isinstance(sender, PushSender)
        assert sender.enabled is True
        assert get_notifier() is sender
    finally:
        reset_notifier()
