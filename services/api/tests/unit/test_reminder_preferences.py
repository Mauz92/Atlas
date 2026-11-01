"""Reminder timing preferences (M8-05): the pure rules and the API surface.

No database is needed: these checks exercise the pure timing rules and inspect the generated OpenAPI
document. The DB-backed behaviour (read/update, rescheduling, user scoping) lives in
``tests/integration/test_reminder_preferences.py``.
"""

from __future__ import annotations

from datetime import time

import pytest

from atlas.main import create_app
from atlas.reminders import (
    DEFAULT_POLICY_NAME,
    MAX_DAYS_BEFORE,
    InvalidReminderTimingError,
    ReminderTiming,
    canonical_name,
    format_at_time,
    parse_at_time,
)


@pytest.mark.parametrize(
    ("days_before", "at_time"),
    [(0, "09:00"), (1, "00:00"), (MAX_DAYS_BEFORE, "23:59"), (7, "18:30")],
)
def test_a_valid_timing_round_trips(days_before: int, at_time: str) -> None:
    timing = ReminderTiming(days_before=days_before, at_time=parse_at_time(at_time))
    assert format_at_time(timing.at_time) == at_time
    assert canonical_name(timing) == f"{days_before}d {at_time}"


@pytest.mark.parametrize(
    ("days_before", "at_time"),
    [
        (-1, time(9, 0)),  # negative lead
        (MAX_DAYS_BEFORE + 1, time(9, 0)),  # beyond the boundary
        (1.5, time(9, 0)),  # not a whole number
        (True, time(9, 0)),  # a bool is not a day count
        (0, "09:00"),  # not a wall-clock time
    ],
)
def test_an_invalid_timing_is_rejected(days_before: object, at_time: object) -> None:
    with pytest.raises(InvalidReminderTimingError):
        ReminderTiming(days_before=days_before, at_time=at_time)  # type: ignore[arg-type]


@pytest.mark.parametrize("value", ["9:00", "24:00", "09:60", "0900", "abc", "", "09:0", "09:000"])
def test_at_time_must_be_a_strict_hh_mm(value: str) -> None:
    with pytest.raises(InvalidReminderTimingError):
        parse_at_time(value)


def test_at_time_parses_into_the_local_wall_clock() -> None:
    assert parse_at_time("07:05") == time(7, 5)
    assert format_at_time(time(7, 5, 30)) == "07:05"  # seconds are not part of the contract


def test_the_default_policy_name_is_reserved() -> None:
    # An override policy is named after its timing, so it can never collide with the default row.
    assert canonical_name(ReminderTiming(days_before=0, at_time=time(9, 0))) != DEFAULT_POLICY_NAME


def test_openapi_exposes_the_reminder_preferences_endpoints() -> None:
    paths = create_app().openapi()["paths"]
    assert set(paths["/api/notifications/reminders"]) >= {"get", "put"}
    assert set(paths["/api/tasks/{task_id}/reminder"]) >= {"get", "put"}


def test_openapi_exposes_the_timing_and_response_schemas() -> None:
    schemas = create_app().openapi()["components"]["schemas"]
    timing = schemas["ReminderTiming"]
    assert set(timing["properties"]) == {"days_before", "at_time"}
    assert timing["properties"]["days_before"]["maximum"] == MAX_DAYS_BEFORE
    assert set(timing["required"]) == {"days_before", "at_time"}

    assert set(schemas["ReminderPreferencesOut"]["properties"]) == {"default"}
    task_reminder = schemas["TaskReminderOut"]
    assert set(task_reminder["properties"]) == {"override", "effective", "remind_at"}
