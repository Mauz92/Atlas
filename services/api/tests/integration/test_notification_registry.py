"""Push destination registry against a real PostgreSQL (M8-03).

Covers the acceptance criteria: register/unregister are idempotent (a re-register upserts, never
duplicates); a user never sees or affects another user's destinations; the registry is validated at
the boundary with no side effects; an invalid/expired destination a delivery reports is disabled and
**not retried**, and a later delivery to that user skips it; and the migration renders the schema,
is reversible and matches the models. Needs a database (``_db``).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from httpx import AsyncClient, Response
from sqlalchemy import create_engine, inspect, select, text

from atlas.config import get_settings
from atlas.db import Base, get_engine, session_scope
from atlas.jobs import worker
from atlas.models import NotificationDevice, Reminder, ReminderStatus, Task, User
from atlas.notifications import NotificationRegistryService
from atlas.reminders import (
    DeliveryResult,
    RecordingNotifier,
    ReminderMessage,
    deliver_reminder,
    ensure_delivery_job,
    reset_notifier,
    set_notifier,
)
from tests.conftest import create_user_via_setup, csrf_headers

pytestmark = pytest.mark.usefixtures("_db")

WEB_ENDPOINT = "https://push.example/owner-web"
WEB_KEYS = {"p256dh": "BPUBLIC-KEY", "auth": "AUTH-SECRET"}
DUE = datetime(2026, 6, 10, 15, 0, tzinfo=UTC)


async def _auth(client: AsyncClient) -> dict[str, str]:
    await create_user_via_setup(client)
    return csrf_headers(client)


async def _owner_id() -> uuid.UUID:
    async with session_scope() as session:
        return (await session.execute(select(User))).scalars().one().id


async def _count_rows() -> int:
    async with session_scope() as session:
        return (
            await session.execute(text("SELECT count(*) FROM notification_devices"))
        ).scalar_one()


async def _device(endpoint: str) -> NotificationDevice | None:
    async with session_scope() as session:
        return await session.scalar(
            select(NotificationDevice).where(NotificationDevice.endpoint == endpoint)
        )


async def _register_web(
    client: AsyncClient,
    headers: dict[str, str],
    *,
    endpoint: str = WEB_ENDPOINT,
    platform: str | None = None,
) -> Response:
    body: dict[str, object] = {"channel": "web", "endpoint": endpoint, **WEB_KEYS}
    if platform is not None:
        body["platform"] = platform
    return await client.post("/api/notifications/devices", json=body, headers=headers)


async def _seed_user() -> uuid.UUID:
    async with session_scope() as session:
        user = User(email=f"{uuid.uuid4()}@example.com", display_name="Owner", password_hash="x")
        session.add(user)
        await session.flush()
        return user.id


async def _seed_reminder(user_id: uuid.UUID) -> tuple[uuid.UUID, uuid.UUID]:
    """A ready-to-deliver task reminder with its durable delivery job queued."""
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
        await ensure_delivery_job(session, reminder)
        return task.id, reminder.id


# --- migration agreement ------------------------------------------------------


async def test_migrations_match_models() -> None:
    engine = get_engine()

    def _diff(sync_connection):
        context = MigrationContext.configure(sync_connection, opts={"compare_type": True})
        return compare_metadata(context, Base.metadata)

    async with engine.connect() as connection:
        diffs = await connection.run_sync(_diff)
    assert diffs == []


def test_migration_upgrade_and_downgrade_round_trip() -> None:
    from atlas.migrations import downgrade, upgrade

    engine = create_engine(get_settings().database_url, future=True)
    try:
        downgrade("e5a91c3f7b64")
        with engine.connect() as connection:
            names = set(inspect(connection).get_table_names())
        assert "notification_devices" not in names
    finally:
        upgrade("head")
    with engine.connect() as connection:
        names = set(inspect(connection).get_table_names())
    engine.dispose()
    assert "notification_devices" in names


# --- register / unregister over HTTP -----------------------------------------


async def test_devices_require_authentication(client: AsyncClient) -> None:
    assert (await client.get("/api/notifications/devices")).status_code == 401
    assert (
        await client.post(
            "/api/notifications/devices",
            json={"channel": "web", "endpoint": WEB_ENDPOINT, **WEB_KEYS},
        )
    ).status_code == 401
    assert (
        await client.delete(f"/api/notifications/devices?channel=web&endpoint={WEB_ENDPOINT}")
    ).status_code == 401


async def test_writes_require_csrf(client: AsyncClient) -> None:
    await create_user_via_setup(client)
    response = await client.post(
        "/api/notifications/devices",
        json={"channel": "web", "endpoint": WEB_ENDPOINT, **WEB_KEYS},
    )
    assert response.status_code == 403


async def test_register_returns_metadata_and_never_the_endpoint_or_keys(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    response = await _register_web(client, headers, platform="Chrome on Linux")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["channel"] == "web"
    assert body["platform"] == "Chrome on Linux"
    assert body["disabled_at"] is None
    assert set(body) == {
        "id",
        "channel",
        "platform",
        "last_seen_at",
        "disabled_at",
        "created_at",
    }
    # The endpoint and the Web Push keys are write-only: never echoed back.
    assert WEB_ENDPOINT not in response.text
    assert WEB_KEYS["p256dh"] not in response.text
    assert WEB_KEYS["auth"] not in response.text
    # ...but the row was stored with them, so a later delivery can target the destination.
    stored = await _device(WEB_ENDPOINT)
    assert stored is not None
    assert stored.p256dh == WEB_KEYS["p256dh"] and stored.auth == WEB_KEYS["auth"]


async def test_registering_the_same_destination_is_idempotent(client: AsyncClient) -> None:
    headers = await _auth(client)
    first = await _register_web(client, headers)
    second = await _register_web(client, headers, platform="Firefox")
    assert first.status_code == second.status_code == 200
    assert first.json()["id"] == second.json()["id"]
    # Re-registering updates in place rather than duplicating (AGENTS.md §9).
    assert await _count_rows() == 1
    stored = await _device(WEB_ENDPOINT)
    assert stored is not None and stored.platform == "Firefox"


async def test_a_native_registration_round_trips(client: AsyncClient) -> None:
    headers = await _auth(client)
    response = await client.post(
        "/api/notifications/devices",
        json={"channel": "android", "endpoint": "fcm-token-1", "platform": "Pixel 9"},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    assert response.json()["channel"] == "android"
    assert response.json()["platform"] == "Pixel 9"
    listing = (await client.get("/api/notifications/devices")).json()["devices"]
    assert [item["channel"] for item in listing] == ["android"]


async def test_unregister_is_idempotent(client: AsyncClient) -> None:
    headers = await _auth(client)
    await _register_web(client, headers)

    removed = await client.delete(
        f"/api/notifications/devices?channel=web&endpoint={WEB_ENDPOINT}", headers=headers
    )
    assert removed.status_code == 204
    assert await _count_rows() == 0
    # Removing a destination that is not there is a no-op, not an error.
    again = await client.delete(
        f"/api/notifications/devices?channel=web&endpoint={WEB_ENDPOINT}", headers=headers
    )
    assert again.status_code == 204


async def test_boundary_validation_changes_nothing(client: AsyncClient) -> None:
    headers = await _auth(client)
    # A web destination must carry both client keys.
    missing_keys = await client.post(
        "/api/notifications/devices",
        json={"channel": "web", "endpoint": WEB_ENDPOINT},
        headers=headers,
    )
    assert missing_keys.status_code == 422, missing_keys.text
    # A native destination must not carry them.
    wrong_keys = await client.post(
        "/api/notifications/devices",
        json={"channel": "ios", "endpoint": "apns-token", **WEB_KEYS},
        headers=headers,
    )
    assert wrong_keys.status_code == 422
    # An unknown channel and an over-long endpoint are rejected too.
    assert (
        await client.post(
            "/api/notifications/devices",
            json={"channel": "desktop", "endpoint": "x", **WEB_KEYS},
            headers=headers,
        )
    ).status_code == 422
    assert (
        await client.post(
            "/api/notifications/devices",
            json={"channel": "android", "endpoint": "x" * 2000},
            headers=headers,
        )
    ).status_code == 422
    assert (
        await client.delete(
            "/api/notifications/devices?channel=desktop&endpoint=x", headers=headers
        )
    ).status_code == 422
    # Nothing was created or removed.
    assert await _count_rows() == 0


# --- strict user scoping ------------------------------------------------------


async def test_devices_are_strictly_user_scoped(client: AsyncClient) -> None:
    headers = await _auth(client)
    await _register_web(client, headers)
    owner = await _owner_id()

    async with session_scope() as session:
        other = User(
            id=uuid.uuid4(),
            email=f"{uuid.uuid4()}@example.com",
            display_name="Other",
            password_hash="x",
        )
        session.add(other)
        await session.flush()
        other_id = other.id
        other_service = NotificationRegistryService(session, other_id)
        await other_service.register(channel="android", endpoint="other-token")

    # The other user sees only their own destination...
    async with session_scope() as session:
        assert await NotificationRegistryService(session, other_id).active_endpoints() == [
            "other-token"
        ]
        # ...and cannot unregister or disable the caller's, even knowing its endpoint.
        assert (
            await NotificationRegistryService(session, other_id).unregister(
                channel="web", endpoint=WEB_ENDPOINT
            )
            is False
        )
        assert await NotificationRegistryService(session, other_id).disable(WEB_ENDPOINT) is False

    # The caller still sees exactly their own destination.
    listing = (await client.get("/api/notifications/devices")).json()["devices"]
    assert len(listing) == 1 and listing[0]["channel"] == "web"
    assert await _count_rows() == 2  # both exist; neither user can see the other's
    assert (await _device(WEB_ENDPOINT)) is not None
    async with session_scope() as session:
        service = NotificationRegistryService(session, owner)
        assert await service.active_endpoints() == [WEB_ENDPOINT]


# --- invalidation (the registry rules) ---------------------------------------


async def test_re_registering_revives_an_invalidated_destination(client: AsyncClient) -> None:
    headers = await _auth(client)
    owner = await _owner_id()
    await _register_web(client, headers)

    async with session_scope() as session:
        service = NotificationRegistryService(session, owner)
        assert await service.disable(WEB_ENDPOINT) is True
        assert await service.active_endpoints() == []
        # Disabling again is a no-op.
        assert await service.disable(WEB_ENDPOINT) is False

    # A fresh register of the same destination revives it.
    await _register_web(client, headers)
    async with session_scope() as session:
        service = NotificationRegistryService(session, owner)
        assert await service.active_endpoints() == [WEB_ENDPOINT]
    assert (await _device(WEB_ENDPOINT)) is not None
    revived = await _device(WEB_ENDPOINT)
    assert revived is not None and revived.disabled_at is None


# --- invalidation driven by a delivery ---------------------------------------


async def test_a_user_without_devices_falls_back_to_an_untargeted_send() -> None:
    user_id = await _seed_user()
    await _seed_reminder(user_id)
    notifier = RecordingNotifier()
    set_notifier(notifier)
    try:
        assert await worker.run_once("worker-1") is True
    finally:
        reset_notifier()
    assert [message.destination for message in notifier.messages] == [None]


async def test_an_invalid_destination_reported_by_a_delivery_is_pruned() -> None:
    user_id = await _seed_user()
    live = "fcm-live-token"
    async with session_scope() as session:
        service = NotificationRegistryService(session, user_id)
        await service.register(
            channel="web", endpoint=WEB_ENDPOINT, p256dh=WEB_KEYS["p256dh"], auth=WEB_KEYS["auth"]
        )
        await service.register(channel="android", endpoint=live)

    _, reminder_id = await _seed_reminder(user_id)

    # The transport reports the web endpoint dead (a Web Push 410) but still delivers elsewhere.
    notifier = RecordingNotifier(invalid_destinations=(WEB_ENDPOINT,))
    set_notifier(notifier)
    try:
        assert await worker.run_once("worker-1") is True
    finally:
        reset_notifier()

    # The dead destination is disabled so it is never retried...
    dead = await _device(WEB_ENDPOINT)
    assert dead is not None and dead.disabled_at is not None
    # ...and a later delivery to the user skips it, targeting only the live destination.
    async with session_scope() as session:
        assert await NotificationRegistryService(session, user_id).active_endpoints() == [live]
        reminder = await session.get(Reminder, reminder_id)
    assert reminder is not None and reminder.status == ReminderStatus.SENT.value
    assert {message.destination for message in notifier.messages} == {WEB_ENDPOINT, live}


class _DeadEndpointNotifier:
    """Reports ``dead`` invalid and fails that send; delivers to every other target."""

    channel = "test"

    def __init__(self, dead: str) -> None:
        self.dead = dead
        self.targets: list[str | None] = []

    async def send(self, message: ReminderMessage) -> DeliveryResult:
        self.targets.append(message.destination)
        if message.destination == self.dead:
            return DeliveryResult(
                delivered=False,
                channel=self.channel,
                detail="410 Gone",
                invalid_destinations=(self.dead,),
            )
        return DeliveryResult(delivered=True, channel=self.channel)


async def test_a_dead_destination_is_disabled_even_when_its_send_fails() -> None:
    user_id = await _seed_user()
    dead = "https://push.example/gone"
    async with session_scope() as session:
        await NotificationRegistryService(session, user_id).register(
            channel="web", endpoint=dead, p256dh="P", auth="A"
        )
    _, reminder_id = await _seed_reminder(user_id)

    failing = _DeadEndpointNotifier(dead)
    set_notifier(failing)
    try:
        assert await worker.run_once("worker-1") is True
    finally:
        reset_notifier()

    # The transport failure is recorded (the durable job retries) AND the dead row is disabled —
    # the disable survives the failed attempt because the worker commits the handler's transaction.
    async with session_scope() as session:
        row = await session.scalar(
            select(NotificationDevice).where(NotificationDevice.endpoint == dead)
        )
        assert row is not None and row.disabled_at is not None
        reminder = await session.get(Reminder, reminder_id)
    assert reminder is not None
    assert reminder.status == ReminderStatus.SCHEDULED.value  # not delivered; still pending
    assert reminder.attempts == 1

    # A later delivery to that user skips the disabled destination entirely (no dead target).
    follow_up = RecordingNotifier()
    set_notifier(follow_up)
    try:
        async with session_scope() as session:
            outcome = await deliver_reminder(session, reminder_id)
    finally:
        reset_notifier()
    assert outcome.delivered is True
    assert [message.destination for message in follow_up.messages] == [None]
    assert failing.targets[0] == dead
