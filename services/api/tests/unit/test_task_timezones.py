"""Task due-date time-zone handling (M3-04): pure logic, no database."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest

from atlas.tasks.timezones import (
    DueState,
    InvalidTimeZoneError,
    NonexistentWallTimeError,
    due_state,
    get_zone,
    is_ambiguous,
    is_valid_time_zone,
    local_date,
    to_local,
    to_utc,
)

AMSTERDAM = "Europe/Amsterdam"
NEW_YORK = "America/New_York"

# Europe/Amsterdam: spring forward 2026-03-29 02:00 -> 03:00; fall back 2026-10-25 03:00 -> 02:00.
GAP = datetime(2026, 3, 29, 2, 30)
OVERLAP = datetime(2026, 10, 25, 2, 30)


def test_winter_wall_time_converts_with_the_standard_offset() -> None:
    assert to_utc(datetime(2026, 1, 2, 9, 30), AMSTERDAM) == datetime(2026, 1, 2, 8, 30, tzinfo=UTC)


def test_summer_wall_time_converts_with_the_daylight_offset() -> None:
    assert to_utc(datetime(2026, 7, 2, 9, 30), AMSTERDAM) == datetime(2026, 7, 2, 7, 30, tzinfo=UTC)


def test_aware_input_is_converted_to_utc() -> None:
    aware = datetime(2026, 1, 2, 9, 30, tzinfo=get_zone(AMSTERDAM))
    assert to_utc(aware) == datetime(2026, 1, 2, 8, 30, tzinfo=UTC)


def test_naive_input_without_a_zone_is_utc() -> None:
    assert to_utc(datetime(2026, 1, 2, 9, 30)) == datetime(2026, 1, 2, 9, 30, tzinfo=UTC)


def test_dst_spring_forward_gap_is_rejected() -> None:
    assert is_ambiguous(GAP, get_zone(AMSTERDAM)) is False
    with pytest.raises(NonexistentWallTimeError):
        to_utc(GAP, AMSTERDAM)


def test_dst_fall_back_overlap_resolves_deterministically() -> None:
    assert is_ambiguous(OVERLAP, get_zone(AMSTERDAM)) is True
    assert to_utc(OVERLAP, AMSTERDAM) == datetime(2026, 10, 25, 0, 30, tzinfo=UTC)
    assert to_utc(OVERLAP, AMSTERDAM, fold=1) == datetime(2026, 10, 25, 1, 30, tzinfo=UTC)


def test_ordinary_times_are_not_ambiguous() -> None:
    assert is_ambiguous(datetime(2026, 1, 2, 9, 30), get_zone(AMSTERDAM)) is False


def test_round_trip_across_a_dst_change() -> None:
    before = to_utc(datetime(2026, 3, 28, 9, 30), AMSTERDAM)
    after = to_utc(datetime(2026, 3, 30, 9, 30), AMSTERDAM)
    # Two calendar days apart, but only 47 hours in real time (one hour is lost to DST).
    assert after - before == timedelta(hours=47)
    assert to_local(before, AMSTERDAM).replace(tzinfo=None) == datetime(2026, 3, 28, 9, 30)
    assert to_local(after, AMSTERDAM).replace(tzinfo=None) == datetime(2026, 3, 30, 9, 30)


def test_invalid_time_zone_is_rejected() -> None:
    assert is_valid_time_zone(AMSTERDAM) is True
    assert is_valid_time_zone("Mars/Phobos") is False
    assert is_valid_time_zone("") is False
    with pytest.raises(InvalidTimeZoneError):
        get_zone("Mars/Phobos")
    with pytest.raises(InvalidTimeZoneError):
        to_utc(datetime(2026, 1, 2, 9, 30), "Mars/Phobos")


def test_local_date_uses_the_zone_calendar_day() -> None:
    instant = datetime(2026, 1, 2, 0, 30, tzinfo=UTC)
    assert local_date(instant, NEW_YORK) == date(2026, 1, 1)
    assert local_date(instant, AMSTERDAM) == date(2026, 1, 2)


def test_due_state_without_a_due_date() -> None:
    now = datetime(2026, 1, 2, 9, 0, tzinfo=UTC)
    assert due_state(None, now=now) is DueState.NONE


def test_due_state_overdue_today_and_upcoming() -> None:
    now = datetime(2026, 1, 2, 9, 0, tzinfo=UTC)
    assert due_state(datetime(2026, 1, 2, 8, 0, tzinfo=UTC), now=now) is DueState.OVERDUE
    assert due_state(datetime(2026, 1, 2, 12, 0, tzinfo=UTC), now=now) is DueState.TODAY
    assert due_state(datetime(2026, 1, 3, 12, 0, tzinfo=UTC), now=now) is DueState.UPCOMING


def test_due_state_today_depends_on_the_zone_calendar_day() -> None:
    # 22:30Z is 23:30 on 01-02 in Amsterdam and 17:30 in New York.
    now = datetime(2026, 1, 2, 22, 30, tzinfo=UTC)
    due = datetime(2026, 1, 2, 23, 30, tzinfo=UTC)
    assert due_state(due, now=now, tz_name=AMSTERDAM) is DueState.UPCOMING  # already 01-03 local
    assert due_state(due, now=now, tz_name=NEW_YORK) is DueState.TODAY
