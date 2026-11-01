"""Pure reminder scheduling rules and notifier (M8-01).

No database: these exercise :mod:`atlas.reminders.schedule` (time-zone-correct fire instants,
DST handling, deliverability) and the notifier abstraction.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, time

import pytest

from atlas.reminders import (
    DELIVERABLE_STATUSES,
    InvalidReminderRuleError,
    LoggingNotifier,
    RecordingNotifier,
    ReminderMessage,
    ReminderRule,
    is_deliverable,
    remind_at_for,
)
from atlas.reminders.schedule import DEFAULT_AT_TIME


def test_default_rule_is_due_day_at_09_00() -> None:
    assert ReminderRule().days_before == 0
    assert ReminderRule().at_time == DEFAULT_AT_TIME == time(9, 0)


def test_a_negative_days_before_is_rejected() -> None:
    with pytest.raises(InvalidReminderRuleError):
        ReminderRule(days_before=-1)


def test_remind_at_is_utc_for_a_zoneless_task() -> None:
    due = datetime(2026, 6, 1, 15, 0, tzinfo=UTC)
    assert remind_at_for(due, ReminderRule(0, time(9, 0))) == datetime(2026, 6, 1, 9, 0, tzinfo=UTC)


def test_remind_at_is_interpreted_in_the_entity_zone_across_dst() -> None:
    # Due 2026-04-01 09:00 CEST: one day before at 09:00 local is 2026-03-31 07:00 UTC.
    summer = remind_at_for(
        datetime(2026, 4, 1, 7, 0, tzinfo=UTC),
        ReminderRule(1, time(9, 0)),
        tz_name="Europe/Amsterdam",
    )
    assert summer == datetime(2026, 3, 31, 7, 0, tzinfo=UTC)

    # Due 2026-01-15 09:00 CET: one day before at 09:00 local is 2026-01-14 08:00 UTC.
    winter = remind_at_for(
        datetime(2026, 1, 15, 8, 0, tzinfo=UTC),
        ReminderRule(1, time(9, 0)),
        tz_name="Europe/Amsterdam",
    )
    assert winter == datetime(2026, 1, 14, 8, 0, tzinfo=UTC)


def test_the_local_calendar_day_governs_days_before() -> None:
    # 2026-06-01 22:00 UTC is 2026-06-02 07:00 in Tokyo, so "one day before" is 2026-06-01 local.
    remind_at = remind_at_for(
        datetime(2026, 6, 1, 22, 0, tzinfo=UTC),
        ReminderRule(1, time(9, 0)),
        tz_name="Asia/Tokyo",
    )
    assert remind_at == datetime(2026, 6, 1, 0, 0, tzinfo=UTC)


def test_a_wall_time_in_the_dst_gap_rolls_forward() -> None:
    # Europe/Amsterdam springs forward on 2026-03-29: 02:30 local does not exist. Rather than drop
    # the reminder it fires just after the gap (03:30 CEST == 01:30 UTC).
    remind_at = remind_at_for(
        datetime(2026, 3, 30, 7, 0, tzinfo=UTC),
        ReminderRule(1, time(2, 30)),
        tz_name="Europe/Amsterdam",
    )
    assert remind_at == datetime(2026, 3, 29, 1, 30, tzinfo=UTC)


@pytest.mark.parametrize("status", sorted(DELIVERABLE_STATUSES))
def test_active_statuses_are_deliverable(status: str) -> None:
    assert is_deliverable(status=status, deleted=False) is True


@pytest.mark.parametrize("status", ["completed", "archived"])
def test_terminal_statuses_are_not_deliverable(status: str) -> None:
    assert is_deliverable(status=status, deleted=False) is False


def test_a_deleted_entity_is_not_deliverable_even_when_active() -> None:
    assert is_deliverable(status="inbox", deleted=True) is False


def _message() -> ReminderMessage:
    return ReminderMessage(
        reminder_id=uuid.uuid4(),
        user_id=uuid.uuid4(),
        entity_type="task",
        entity_id=uuid.uuid4(),
        title="Water the plants",
        body='Task "Water the plants" is due.',
        fire_at=datetime(2026, 6, 1, 9, 0, tzinfo=UTC),
        due_at=datetime(2026, 6, 1, 17, 0, tzinfo=UTC),
        time_zone="Europe/Amsterdam",
    )


async def test_the_recording_notifier_records_messages() -> None:
    notifier = RecordingNotifier()
    result = await notifier.send(_message())
    assert result.delivered is True
    assert result.channel == "recording"
    assert len(notifier.messages) == 1


async def test_the_logging_notifier_reports_success() -> None:
    result = await LoggingNotifier().send(_message())
    assert result.delivered is True
    assert result.channel == "log"


def test_the_dedupe_key_is_stable_for_a_reminder() -> None:
    message = _message()
    assert message.dedupe_key == f"reminder:{message.reminder_id}"
