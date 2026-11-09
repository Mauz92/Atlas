"""Snooze and dismiss: the synced outcome of a reminder notification (M8-04a; SYNC_PROTOCOL 14.5).

A device shows a reminder from its own schedule; what the owner *does* with it (snooze, dismiss)
is the only thing that has to reach the other devices. This module holds the pure rules and the
transactional application:

* ``snooze`` -> ``snoozed_until = base + n`` and the dismissal is cleared, so a snooze after a
  dismiss re-arms. ``base`` is the server clock, or - when the device sends ``acted_at`` - that
  instant *clamped* to a safe window around the server clock (:func:`clamp_acted_at`, R-68), so a
  snooze made offline at 10:00 for an hour and synced at 14:00 rings the other devices at once
  instead of at 15:00;
* ``dismiss`` -> ``acknowledged_at = max(base, effective_at, remind_at)`` and the snooze is cleared.
  Taking the larger value makes a dismissal that arrives *before* the occurrence is due cover that
  occurrence
  (a device rule "acknowledged at or after effective_at" then needs no special case);
* the later action in server order wins; there is no ``409`` for a stale ``base_revision`` (an
  action is intent, not a field edit) - the answer carries the current entity and ``stale``;
* an action on a cancelled reminder changes nothing (``applied = false``);
* completing a task is *not* a reminder action: it is the normal task write, which cancels the
  reminder through :func:`atlas.reminders.service.sync_task`.

Wall-clock arithmetic stays on the server: ``tomorrow_morning`` is computed here with the same zone
helpers as the reminder instant (09:00 the next local day; a DST gap rolls forward like a reminder).
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, time, timedelta
from typing import Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Reminder, ReminderDelivery, Task
from ..tasks.timezones import to_local, to_utc
from .schedule import DEFAULT_AT_TIME, ReminderRule, remind_at_for
from .service import ARMED, CANCELLED, effective_zone, lock_for_update, publish

logger = logging.getLogger("atlas.reminders")

#: The fixed duration presets (ADR-0068 Q7); "tomorrow morning" is the fourth, see below.
SNOOZE_SECONDS: frozenset[int] = frozenset({600, 3600, 10800})
#: The local time "tomorrow morning" resolves to.
TOMORROW_MORNING_AT = DEFAULT_AT_TIME
#: R-68 / ADR-0068 D11: how far back a device-reported ``acted_at`` is believed. An action queued
#: longer ago than this is treated as made this long ago (the snooze then ends no later than
#: ``server now - 24 h + n``, i.e. a missed snooze rings at once). Constants, not settings: they
#: bound the damage of a wrong device clock and have no operational reason to change.
ACTED_AT_MAX_AGE = timedelta(hours=24)
#: How far *ahead* of the server clock a device-reported ``acted_at`` is believed (clock skew).
ACTED_AT_MAX_FUTURE = timedelta(minutes=5)

ActionKind = Literal["snooze", "dismiss"]


class ReminderNotFoundError(LookupError):
    """No reminder with this id belongs to the caller (also another user's id: no probing)."""


class ReminderRevisionAheadError(ValueError):
    """The device claims to have seen a revision the server never produced (restored backup?)."""

    def __init__(self, current_revision: int) -> None:
        super().__init__("base_revision is ahead of the server")
        self.current_revision = current_revision


@dataclass(frozen=True, slots=True)
class ReminderActionResult:
    reminder: Reminder
    delivered_at: datetime | None
    applied: bool
    stale: bool


def effective_at(remind_at: datetime, snoozed_until: datetime | None) -> datetime:
    """The instant a device fires: the snooze when there is one, else the reminder time."""
    return snoozed_until or remind_at


def clamp_acted_at(acted_at: datetime | None, now: datetime) -> datetime:
    """The instant a snooze or dismissal is based on (R-68).

    ``acted_at`` is when the owner tapped, by the *device* clock, and is only a hint about the
    delay between the tap and the sync. It is clamped, never rejected, to
    ``[now - ACTED_AT_MAX_AGE, now + ACTED_AT_MAX_FUTURE]``; absent means ``now``. It is never used
    to order actions (arrival order decides, ADR-0059 D11) and never stored: it only moves the
    instant that ``snooze_for_seconds`` is added to. A device with a clock that is wrong by more
    than the window gets the window's edge, so a wrong clock can shift a snooze by at most 24 h
    earlier or 5 min later than the server's own reading.
    """
    if acted_at is None:
        return now
    acted_at = acted_at.astimezone(UTC)
    return min(max(acted_at, now - ACTED_AT_MAX_AGE), now + ACTED_AT_MAX_FUTURE)


def snooze_until(now: datetime, *, seconds: int) -> datetime:
    if seconds not in SNOOZE_SECONDS:
        msg = f"unsupported snooze duration {seconds}"
        raise ValueError(msg)
    return now + timedelta(seconds=seconds)


def tomorrow_morning(now: datetime, tz_name: str | None) -> datetime:
    """09:00 on the next calendar day in ``tz_name`` (UTC when ``None``), as a UTC instant.

    Anchored on local noon of tomorrow - an instant that exists on every day, so a DST transition
    near midnight cannot move the date - and then delegated to :func:`remind_at_for`, which pins
    the wall-clock time and rolls a DST gap forward. No second copy of the date arithmetic.
    """
    tomorrow = to_local(now, tz_name).date() + timedelta(days=1)
    noon = to_utc(datetime.combine(tomorrow, time(12, 0)), tz_name)
    rule = ReminderRule(days_before=0, at_time=TOMORROW_MORNING_AT)
    return remind_at_for(noon, rule, tz_name=tz_name)


async def apply_action(
    session: AsyncSession,
    user_id: uuid.UUID,
    reminder_id: uuid.UUID,
    *,
    kind: ActionKind,
    snooze_for_seconds: int | None = None,
    until: Literal["tomorrow_morning"] | None = None,
    base_revision: int | None = None,
    acted_at: datetime | None = None,
    device_id: uuid.UUID | None = None,
    now: datetime | None = None,
) -> ReminderActionResult:
    """Apply one action under the locks of :func:`lock_for_update`; commit is the caller's.

    Raises :class:`ReminderNotFoundError` for an unknown or foreign id and
    :class:`ReminderRevisionAheadError` when ``base_revision`` exceeds the stored revision.
    """
    server_now = now or datetime.now(UTC)
    moment = clamp_acted_at(acted_at, server_now)
    found = await session.scalar(
        select(Reminder).where(Reminder.id == reminder_id, Reminder.user_id == user_id)
    )
    if found is None:
        raise ReminderNotFoundError(str(reminder_id))
    await lock_for_update(session, found)
    if base_revision is not None and base_revision > found.revision:
        raise ReminderRevisionAheadError(found.revision)
    stale = base_revision is not None and base_revision < found.revision
    applied = False
    if found.state == ARMED:
        if kind == "snooze":
            if until == "tomorrow_morning":
                task = await session.get(Task, found.entity_id)
                zone = await effective_zone(session, task) if task is not None else None
                target = tomorrow_morning(moment, zone)
            else:
                assert snooze_for_seconds is not None
                target = snooze_until(moment, seconds=snooze_for_seconds)
            applied = await publish(session, found, snoozed_until=target, acknowledged_at=None)
        else:
            due = effective_at(found.remind_at, found.snoozed_until)
            if found.acknowledged_at is None or found.acknowledged_at < due:
                # ``remind_at`` as well: dismissing clears the snooze, so the occurrence that
                # becomes effective again is ``remind_at``; a snooze that ends before it (an old
                # ``acted_at`` from a device clock that was behind) must not let the dismissed
                # reminder ring again.
                applied = await publish(
                    session,
                    found,
                    snoozed_until=None,
                    acknowledged_at=max(moment, due, found.remind_at),
                )
            # else: already dismissed - a repeat (another device, a retry with a new id) is a no-op
    # Audit without content: ids, the kind and the outcome - never the task title or text.
    logger.info(
        "reminder.action",
        extra={
            "reminder_id": str(found.id),
            "kind": kind,
            "applied": applied,
            "stale": stale,
            "state": found.state,
            "revision": found.revision,
            "device_id": str(device_id) if device_id else None,
            # seconds the base was moved back from the server clock (0 without acted_at): audit only
            "acted_lag_s": int((server_now - moment).total_seconds()),
        },
    )
    delivered_at = await session.scalar(
        select(ReminderDelivery.delivered_at).where(ReminderDelivery.reminder_id == found.id)
    )
    return ReminderActionResult(found, delivered_at, applied, stale)


__all__ = [
    "ACTED_AT_MAX_AGE",
    "ACTED_AT_MAX_FUTURE",
    "CANCELLED",
    "SNOOZE_SECONDS",
    "ReminderActionResult",
    "ReminderNotFoundError",
    "ReminderRevisionAheadError",
    "apply_action",
    "clamp_acted_at",
    "effective_at",
    "snooze_until",
    "tomorrow_morning",
]
