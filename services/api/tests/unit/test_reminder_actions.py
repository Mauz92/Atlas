"""Pure rules of the reminder actions and the feed vocabulary (M8-04a; no database)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from pydantic import ValidationError

from atlas.api.schemas import HomeTimeZone, ReminderActionRequest
from atlas.changes.feed import ChangeEntityType, parse_types
from atlas.reminders.actions import (
    ACTED_AT_MAX_AGE,
    ACTED_AT_MAX_FUTURE,
    SNOOZE_SECONDS,
    clamp_acted_at,
    effective_at,
    snooze_until,
    tomorrow_morning,
)
from atlas.sync.protocol import ENTITY_SCHEMAS

NOW = datetime(2026, 6, 10, 12, 0, tzinfo=UTC)


def test_effective_at_prefers_the_snooze() -> None:
    assert effective_at(NOW, None) == NOW
    later = NOW + timedelta(hours=1)
    assert effective_at(NOW, later) == later


@pytest.mark.parametrize("seconds", sorted(SNOOZE_SECONDS))
def test_snooze_presets_are_durations_from_now(seconds: int) -> None:
    assert snooze_until(NOW, seconds=seconds) == NOW + timedelta(seconds=seconds)


@pytest.mark.parametrize("seconds", [0, 60, 599, 601, 86400, -600])
def test_other_durations_are_refused(seconds: int) -> None:
    with pytest.raises(ValueError, match="unsupported"):
        snooze_until(NOW, seconds=seconds)


def test_the_presets_are_exactly_the_approved_ones() -> None:
    assert {600, 3600, 10800} == SNOOZE_SECONDS  # Q7: 10 min, 1 h, 3 h (+ tomorrow morning)


def test_tomorrow_morning_is_nine_local_the_next_day() -> None:
    # 2026-06-10 22:30 Amsterdam (CEST, UTC+2) -> 2026-06-11 09:00 CEST = 07:00 UTC
    now = datetime(2026, 6, 10, 20, 30, tzinfo=UTC)
    assert tomorrow_morning(now, "Europe/Amsterdam") == datetime(2026, 6, 11, 7, 0, tzinfo=UTC)


def test_tomorrow_morning_uses_the_local_date_not_the_utc_date() -> None:
    # 23:30 UTC is already the next day in Auckland (UTC+12 in June): tomorrow is two UTC days on
    now = datetime(2026, 6, 10, 23, 30, tzinfo=UTC)
    assert tomorrow_morning(now, "Pacific/Auckland") == datetime(2026, 6, 11, 21, 0, tzinfo=UTC)


def test_tomorrow_morning_without_a_zone_is_utc() -> None:
    assert tomorrow_morning(NOW, None) == datetime(2026, 6, 11, 9, 0, tzinfo=UTC)


def test_tomorrow_morning_across_the_spring_forward_night() -> None:
    # 2026-03-28 evening Amsterdam (CET, UTC+1); 03-29 is the 23 h day, 09:00 is CEST (UTC+2)
    now = datetime(2026, 3, 28, 21, 0, tzinfo=UTC)
    assert tomorrow_morning(now, "Europe/Amsterdam") == datetime(2026, 3, 29, 7, 0, tzinfo=UTC)


def test_tomorrow_morning_across_the_fall_back_night() -> None:
    # 2026-10-24 evening (CEST); 10-25 is the 25 h day, 09:00 is CET (UTC+1) = 08:00 UTC
    now = datetime(2026, 10, 24, 21, 0, tzinfo=UTC)
    assert tomorrow_morning(now, "Europe/Amsterdam") == datetime(2026, 10, 25, 8, 0, tzinfo=UTC)


def test_tomorrow_morning_just_after_local_midnight_is_still_tomorrow() -> None:
    # 00:30 local on the 25-hour day: tomorrow is the 26th, not "the same date 24 h later"
    now = datetime(2026, 10, 24, 22, 30, tzinfo=UTC)  # 00:30 CEST on 10-25
    assert tomorrow_morning(now, "Europe/Amsterdam") == datetime(2026, 10, 26, 8, 0, tzinfo=UTC)


def _req(**body: object) -> ReminderActionRequest:
    return ReminderActionRequest.model_validate({"action_id": str(uuid.uuid4()), **body})


def test_a_snooze_needs_exactly_one_target() -> None:
    assert _req(kind="snooze", snooze_for_seconds=600).snooze_for_seconds == 600
    assert _req(kind="snooze", until="tomorrow_morning").until == "tomorrow_morning"
    for body in (
        {"kind": "snooze"},
        {"kind": "snooze", "snooze_for_seconds": 600, "until": "tomorrow_morning"},
    ):
        with pytest.raises(ValidationError):
            _req(**body)


def test_a_dismiss_takes_no_duration_and_odd_durations_are_422() -> None:
    assert _req(kind="dismiss").kind == "dismiss"
    with pytest.raises(ValidationError):
        _req(kind="dismiss", snooze_for_seconds=600)
    with pytest.raises(ValidationError):
        _req(kind="snooze", snooze_for_seconds=601)
    with pytest.raises(ValidationError):
        _req(kind="complete")
    with pytest.raises(ValidationError):
        _req(kind="dismiss", base_revision=0)


def test_home_time_zone_validates_the_iana_name() -> None:
    assert HomeTimeZone(time_zone=" Europe/Amsterdam ").time_zone == "Europe/Amsterdam"
    assert HomeTimeZone(time_zone=None).time_zone is None
    for bad in ("", "  ", "Mars/Olympus", "../etc/passwd", "UTC+2"):
        with pytest.raises(ValidationError):
            HomeTimeZone(time_zone=bad)


def test_the_reminder_entity_is_part_of_the_vocabulary() -> None:
    assert ChangeEntityType.REMINDER == "reminder"
    assert ENTITY_SCHEMAS["reminder"] == 1
    assert parse_types("reminder,task") == frozenset({"reminder", "task"})


# --- acted_at (R-68, ADR-0068 D11) ---------------------------------------------------------


def test_the_clamp_constants_are_the_documented_ones() -> None:
    assert timedelta(hours=24) == ACTED_AT_MAX_AGE
    assert timedelta(minutes=5) == ACTED_AT_MAX_FUTURE


def test_without_acted_at_the_base_is_the_server_clock() -> None:
    assert clamp_acted_at(None, NOW) == NOW


def test_an_acted_at_inside_the_window_is_used_as_sent() -> None:
    four_hours_ago = NOW - timedelta(hours=4)
    assert clamp_acted_at(four_hours_ago, NOW) == four_hours_ago
    assert clamp_acted_at(NOW + timedelta(minutes=5), NOW) == NOW + timedelta(minutes=5)
    assert clamp_acted_at(NOW - timedelta(hours=24), NOW) == NOW - timedelta(hours=24)


def test_an_acted_at_in_the_future_is_clamped_not_refused() -> None:
    assert clamp_acted_at(NOW + timedelta(days=3), NOW) == NOW + ACTED_AT_MAX_FUTURE
    assert clamp_acted_at(NOW + timedelta(minutes=5, seconds=1), NOW) == NOW + ACTED_AT_MAX_FUTURE


def test_an_acted_at_older_than_the_window_is_clamped_not_refused() -> None:
    assert clamp_acted_at(NOW - timedelta(days=30), NOW) == NOW - ACTED_AT_MAX_AGE
    assert clamp_acted_at(NOW - timedelta(hours=24, seconds=1), NOW) == NOW - ACTED_AT_MAX_AGE


def test_the_clamp_converts_any_offset_to_utc() -> None:
    from datetime import timezone

    local = (NOW - timedelta(hours=2)).astimezone(timezone(timedelta(hours=5, minutes=30)))
    result = clamp_acted_at(local, NOW)
    assert result == NOW - timedelta(hours=2) and result.utcoffset() == timedelta(0)


def test_the_request_accepts_acted_at_only_with_an_offset() -> None:
    ok = _req(kind="dismiss", acted_at="2026-06-10T10:00:00+02:00")
    assert ok.acted_at == datetime(2026, 6, 10, 8, 0, tzinfo=UTC)
    assert _req(kind="dismiss").acted_at is None
    with pytest.raises(ValidationError):
        _req(kind="dismiss", acted_at="2026-06-10T10:00:00")  # naive: the zone would be a guess
    with pytest.raises(ValidationError):
        _req(kind="dismiss", acted_at="yesterday")
