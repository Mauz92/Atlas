"""Web Push delivery end to end against a real PostgreSQL (M8-02).

Covers the acceptance criteria: the sender targets the user's **active** web subscriptions (carrying
their client keys from the M8-03 registry) and a push service reporting the destination gone
(``404``/``410``) is reported as an invalid destination so the registry disables it and never
retries it. The transport is a fake, so no real push service is contacted (``AGENTS.md`` §13); the
durable delivery path, the registry and the database are the real ones. Needs a database (``_db``).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from pywebpush import WebPushException
from sqlalchemy import select

from atlas.config import get_settings
from atlas.db import session_scope
from atlas.models import NotificationDevice, Reminder, ReminderDelivery, ReminderStatus, Task, User
from atlas.notifications import NotificationRegistryService
from atlas.notifications.vapid import VapidConfig
from atlas.reminders import RecordingNotifier, ReminderDeliveryError, deliver_reminder
from atlas.reminders.push import PushSender
from tests.conftest import create_user_via_setup

pytestmark = pytest.mark.usefixtures("_db")

WEB_ENDPOINT = "https://push.example/owner-web"
WEB_KEYS = {"p256dh": "BPUBLIC-KEY", "auth": "AUTH-SECRET"}
DUE = datetime(2026, 6, 10, 15, 0, tzinfo=UTC)

VAPID = VapidConfig(public_key="pub", private_key="priv", subject="mailto:ops@atlas.test")


@pytest.fixture(autouse=True)
def _fresh_settings():
    """Keep the cached settings from leaking a test's VAPID environment between tests."""
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


class FakeResponse:
    def __init__(self, status_code: int) -> None:
        self.status_code = status_code
        self.headers: dict[str, str] = {}
        self.text = ""
        self.reason = ""


class PushTransport:
    """A fake ``pywebpush.webpush``: records calls, can fail them."""

    def __init__(self, *, status: int | None = None) -> None:
        self.calls: list[dict[str, object]] = []
        self._status = status

    def __call__(self, **kwargs: object) -> None:
        self.calls.append(kwargs)
        if self._status is not None:
            raise WebPushException("rejected", response=FakeResponse(self._status))


async def _seed_user() -> uuid.UUID:
    async with session_scope() as session:
        user = User(email=f"{uuid.uuid4()}@example.com", display_name="Owner", password_hash="x")
        session.add(user)
        await session.flush()
        return user.id


async def _register_web(user_id: uuid.UUID, *, endpoint: str = WEB_ENDPOINT) -> None:
    async with session_scope() as session:
        await NotificationRegistryService(session, user_id).register(
            channel="web", endpoint=endpoint, p256dh=WEB_KEYS["p256dh"], auth=WEB_KEYS["auth"]
        )


async def _seed_reminder(user_id: uuid.UUID) -> uuid.UUID:
    async with session_scope() as session:
        task = Task(
            user_id=user_id,
            title="Water the plants",
            status="inbox",
            due_at=DUE,
            time_zone="Europe/Amsterdam",
        )
        session.add(task)
        await session.flush()
        reminder = Reminder(
            user_id=user_id,
            entity_type="task",
            entity_id=task.id,
            remind_at=datetime.now(UTC) - timedelta(minutes=5),
            status=ReminderStatus.SCHEDULED.value,
        )
        session.add(reminder)
        await session.flush()
        return reminder.id


async def test_a_web_destination_is_pushed_with_its_subscription_keys() -> None:
    user_id = await _seed_user()
    await _register_web(user_id)
    reminder_id = await _seed_reminder(user_id)

    transport = PushTransport()
    sender = PushSender(VAPID, transport=transport)

    async with session_scope() as session:
        outcome = await deliver_reminder(session, reminder_id, notifier=sender)

    assert outcome.delivered is True
    assert len(transport.calls) == 1
    assert transport.calls[0]["subscription_info"] == {
        "endpoint": WEB_ENDPOINT,
        "keys": {"p256dh": WEB_KEYS["p256dh"], "auth": WEB_KEYS["auth"]},
    }

    async with session_scope() as session:
        reminder = await session.get(Reminder, reminder_id)
        delivery = await session.scalar(
            select(ReminderDelivery).where(ReminderDelivery.reminder_id == reminder_id)
        )
    assert reminder is not None and reminder.status == ReminderStatus.SENT.value
    assert delivery is not None and delivery.channel == "webpush"


async def test_a_gone_destination_is_disabled_and_never_retried() -> None:
    user_id = await _seed_user()
    await _register_web(user_id)
    reminder_id = await _seed_reminder(user_id)

    sender = PushSender(VAPID, transport=PushTransport(status=410))

    # The transport failure is recorded and raised so the durable job retries...
    async with session_scope() as session:
        with pytest.raises(ReminderDeliveryError):
            await deliver_reminder(session, reminder_id, notifier=sender)

    # ...and the 410 disabled exactly that destination, so it is never retried (M8-03).
    async with session_scope() as session:
        device = await session.scalar(
            select(NotificationDevice).where(NotificationDevice.endpoint == WEB_ENDPOINT)
        )
        assert device is not None and device.disabled_at is not None
        assert await NotificationRegistryService(session, user_id).active_endpoints() == []

    # A later delivery to that user skips the disabled destination (no target at all).
    follow_up = RecordingNotifier()
    async with session_scope() as session:
        outcome = await deliver_reminder(session, reminder_id, notifier=follow_up)
    assert outcome.delivered is True
    assert [message.destination for message in follow_up.messages] == [None]


async def test_the_config_endpoint_reports_web_push_disabled_without_keys(
    client: AsyncClient,
) -> None:
    await create_user_via_setup(client)

    response = await client.get("/api/notifications/config")

    assert response.status_code == 200, response.text
    assert response.json() == {"enabled": False, "vapid_public_key": None}


async def test_the_config_endpoint_exposes_only_the_public_key(
    client: AsyncClient, monkeypatch
) -> None:
    await create_user_via_setup(client)
    monkeypatch.setenv("VAPID_PUBLIC_KEY", "BPublicKeyForTheBrowser")
    monkeypatch.setenv("VAPID_PRIVATE_KEY", "PRIVATE-KEY-NEVER-RETURNED")
    monkeypatch.setenv("VAPID_SUBJECT", "mailto:ops@atlas.test")
    get_settings.cache_clear()

    response = await client.get("/api/notifications/config")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["enabled"] is True
    assert body["vapid_public_key"] == "BPublicKeyForTheBrowser"
    assert "PRIVATE-KEY-NEVER-RETURNED" not in response.text


async def test_the_config_endpoint_requires_authentication(client: AsyncClient) -> None:
    response = await client.get("/api/notifications/config")
    assert response.status_code == 401
