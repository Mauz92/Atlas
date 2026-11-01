"""Reminder delivery core (M8-01).

The durable ``reminder.deliver`` job calls :func:`deliver_reminder`. It is **idempotent** and fires
a reminder **at most once**:

- it refuses to act unless the reminder is still ``scheduled`` and due, so a stale job left behind
  by a reschedule or a cancellation is a no-op;
- it skips an entity that is cancelled/completed/archived (or soft-deleted) and marks the reminder
  cancelled, so a completed or deleted task is never reminded (``PRODUCT_SPEC.md`` §5.6);
- it writes the single :class:`~atlas.models.ReminderDelivery` row (unique per reminder) in the
  same transaction that marks the reminder ``sent``, so a retry — after a worker restart or a
  transport retry — finds the record and does nothing.

A transport failure is recorded on the reminder (``attempts``, ``last_attempt_at``) and raised so
the durable job retries with backoff. The only window in which a message can be sent twice is a
crash between the transport accepting it and the transaction committing;
``ReminderMessage.dedupe_key`` exists so the transport or client can drop that duplicate.

Delivery targets the user's **registered destinations** (M8-03): each active
:class:`~atlas.models.NotificationDevice` is handed to the notifier in turn, and a destination the
transport reports invalid/expired (a Web Push ``404``/``410``) is **disabled** so it is never
retried. A user with no active destination falls back to a single untargeted send, so the default
notifier still handles the reminder (M8-02/M8-04 add the real channel transports).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import NotificationDevice, Reminder, ReminderDelivery, Task
from ..models.reminder import ReminderEntityType, ReminderStatus
from ..notifications import WEB_CHANNEL, NotificationRegistryService
from .notifier import DeliveryResult, Notifier, PushSubscription, ReminderMessage, get_notifier
from .schedule import is_deliverable


class ReminderDeliveryError(RuntimeError):
    """The transport rejected the notification; the durable job should retry."""


@dataclass(frozen=True, slots=True)
class DeliveryOutcome:
    """The result of one delivery attempt."""

    delivered: bool
    reason: str | None = None


def _skip(reason: str) -> DeliveryOutcome:
    return DeliveryOutcome(delivered=False, reason=reason)


async def _delivery_exists(session: AsyncSession, reminder_id: uuid.UUID) -> bool:
    found = await session.scalar(
        select(ReminderDelivery.id).where(ReminderDelivery.reminder_id == reminder_id)
    )
    return found is not None


async def deliver_reminder(
    session: AsyncSession,
    reminder_id: uuid.UUID,
    *,
    expected_remind_at: datetime | None = None,
    notifier: Notifier | None = None,
    now: datetime | None = None,
) -> DeliveryOutcome:
    """Deliver one reminder exactly once, or explain why it was skipped."""
    moment = now or datetime.now(UTC)
    reminder = await session.get(Reminder, reminder_id)
    if reminder is None:
        return _skip("reminder does not exist")
    if reminder.status != ReminderStatus.SCHEDULED.value:
        return _skip(f"reminder is {reminder.status}")
    # A job enqueued for an earlier fire time than the reminder now carries belongs to a superseded
    # schedule: skip it, the job for the current remind_at will deliver.
    if expected_remind_at is not None and reminder.remind_at != expected_remind_at:
        return _skip("reminder was rescheduled")
    if reminder.remind_at > moment:
        return _skip("reminder is not due yet")

    entity = await _load_entity(session, reminder)
    if entity is None or entity.user_id != reminder.user_id:
        reminder.status = ReminderStatus.CANCELLED.value
        await session.flush()
        return _skip("entity does not exist")
    if not is_deliverable(status=entity.status, deleted=entity.deleted_at is not None):
        reminder.status = ReminderStatus.CANCELLED.value
        await session.flush()
        return _skip(f"task status is {entity.status}")

    # At-most-once: the delivery record was already written (a retried job, a restart) — do nothing.
    if await _delivery_exists(session, reminder.id):
        if reminder.status != ReminderStatus.SENT.value:
            reminder.status = ReminderStatus.SENT.value
            await session.flush()
        return _skip("already delivered")

    message_targets = await _targets(session, reminder.user_id)
    channel = notifier or get_notifier()
    registry = NotificationRegistryService(session, reminder.user_id)

    invalid: list[str] = []
    delivered_all = True
    failure_detail: str | None = None
    results: list[DeliveryResult] = []
    for target in message_targets:
        message = _build_message(reminder, entity, device=target)
        try:
            result = await channel.send(message)
        except Exception as exc:  # transport failure → record and retry
            reminder.attempts += 1
            reminder.last_attempt_at = moment
            await session.flush()
            raise ReminderDeliveryError(str(exc)) from exc
        results.append(result)
        invalid.extend(result.invalid_destinations)
        if not result.delivered:
            delivered_all = False
            failure_detail = result.detail or "notifier reported failure"

    # A destination a transport reported invalid/expired is pruned so it is never retried (M8-03).
    if invalid:
        await registry.disable_many(invalid, now=moment)
        await session.flush()

    if not delivered_all:
        reminder.attempts += 1
        reminder.last_attempt_at = moment
        await session.flush()
        raise ReminderDeliveryError(failure_detail or "notifier reported failure")

    session.add(
        ReminderDelivery(
            reminder_id=reminder.id,
            channel=results[0].channel,
            delivered_at=moment,
            detail=results[0].detail,
        )
    )
    reminder.status = ReminderStatus.SENT.value
    reminder.attempts += 1
    reminder.last_attempt_at = moment
    await session.flush()
    return DeliveryOutcome(delivered=True)


async def _targets(session: AsyncSession, user_id: uuid.UUID) -> list[NotificationDevice | None]:
    """The destinations a delivery should target for ``user_id``.

    The user's **active** registered destinations (M8-03), oldest first. When the user has none —
    either they registered nothing or every destination was invalidated — a single untargeted send
    (``None``) is used, so the default notifier still handles the reminder rather than dropping it
    silently. Real channel transports (M8-02/M8-04) receive the concrete destination instead: a web
    subscription carries its client keys so the Web Push transport can send without a second lookup.
    """
    devices = await NotificationRegistryService(session, user_id).active_devices()
    return list(devices) if devices else [None]


async def _load_entity(session: AsyncSession, reminder: Reminder) -> Task | None:
    """Load the entity a reminder targets, or ``None`` when its type is unsupported."""
    if reminder.entity_type != ReminderEntityType.TASK.value:
        return None
    return await session.get(Task, reminder.entity_id)


def _subscription_for(device: NotificationDevice | None) -> PushSubscription | None:
    """The Web Push subscription for a destination, or ``None`` when it is not a web one.

    A web row always carries both keys (the M8-03 registry requires them), but the guard keeps a
    half-formed row from reaching the transport.
    """
    if device is None or device.channel != WEB_CHANNEL:
        return None
    if not (device.p256dh and device.auth):
        return None
    return PushSubscription(endpoint=device.endpoint, p256dh=device.p256dh, auth=device.auth)


def _build_message(
    reminder: Reminder, task: Task, *, device: NotificationDevice | None = None
) -> ReminderMessage:
    body = f'Task "{task.title}" is due.'
    return ReminderMessage(
        reminder_id=reminder.id,
        user_id=reminder.user_id,
        entity_type=reminder.entity_type,
        entity_id=task.id,
        title=task.title,
        body=body,
        fire_at=reminder.remind_at,
        due_at=task.due_at,
        time_zone=task.time_zone,
        destination=device.endpoint if device is not None else None,
        subscription=_subscription_for(device),
    )


__all__ = ["DeliveryOutcome", "ReminderDeliveryError", "deliver_reminder"]
