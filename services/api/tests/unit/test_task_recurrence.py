"""RRULE recurrence and completion semantics (M3-05): pure logic, no database."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest

from atlas.tasks.recurrence import (
    InvalidRecurrenceRuleError,
    RecurrenceSpec,
    build_spec,
    localize_dtstart,
    next_occurrence,
    occurrences,
    series_bounds,
    validate_rule,
)
from atlas.tasks.timezones import InvalidTimeZoneError, NonexistentWallTimeError

AMSTERDAM = "Europe/Amsterdam"
NEW_YORK = "America/New_York"

# Europe/Amsterdam: spring forward 2026-03-29 02:00 -> 03:00; fall back 2026-10-25 03:00 -> 02:00.
GAP = datetime(2026, 3, 29, 2, 30)


def _spec(
    rule: str,
    dtstart: datetime,
    *,
    time_zone: str | None = None,
    count: int | None = None,
    end_date: date | None = None,
) -> RecurrenceSpec:
    return build_spec(rule, dtstart, time_zone=time_zone, count=count, end_date=end_date)


def _utc(*parts: int) -> datetime:
    return datetime(*parts, tzinfo=UTC)


# --- Expansion -------------------------------------------------------------


def test_daily_count_expands_to_the_expected_instants() -> None:
    spec = _spec("FREQ=DAILY;COUNT=3", _utc(2026, 1, 2, 9, 30))
    assert occurrences(spec) == [
        _utc(2026, 1, 2, 9, 30),
        _utc(2026, 1, 3, 9, 30),
        _utc(2026, 1, 4, 9, 30),
    ]


def test_weekly_byday_expands_on_the_selected_weekdays() -> None:
    spec = _spec("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=3", _utc(2026, 1, 5, 8, 0))  # Monday
    assert occurrences(spec) == [
        _utc(2026, 1, 5, 8, 0),  # Mon
        _utc(2026, 1, 7, 8, 0),  # Wed
        _utc(2026, 1, 12, 8, 0),  # Mon
    ]


def test_an_open_ended_rule_is_capped_by_the_outer_count() -> None:
    spec = _spec("FREQ=DAILY", _utc(2026, 1, 2, 9, 30), count=2)
    assert len(occurrences(spec)) == 2


def test_a_leading_rrule_prefix_is_accepted() -> None:
    assert validate_rule("RRULE:FREQ=DAILY") == "FREQ=DAILY"
    spec = _spec(" RRULE:FREQ=DAILY;COUNT=1 ", _utc(2026, 1, 2, 9, 30))
    assert occurrences(spec) == [_utc(2026, 1, 2, 9, 30)]


# --- Time zones and DST ----------------------------------------------------


def test_dst_spring_forward_keeps_the_local_wall_clock() -> None:
    # Daily 09:30 Amsterdam: 08:30Z while on CET, 07:30Z once on CEST.
    spec = _spec("FREQ=DAILY;COUNT=3", datetime(2026, 3, 28, 9, 30), time_zone=AMSTERDAM)
    assert occurrences(spec) == [
        _utc(2026, 3, 28, 8, 30),
        _utc(2026, 3, 29, 7, 30),
        _utc(2026, 3, 30, 7, 30),
    ]


def test_dst_fall_back_keeps_the_local_wall_clock() -> None:
    # Daily 09:30 Amsterdam: 07:30Z while on CEST, 08:30Z once back on CET.
    spec = _spec("FREQ=DAILY;COUNT=3", datetime(2026, 10, 24, 9, 30), time_zone=AMSTERDAM)
    assert occurrences(spec) == [
        _utc(2026, 10, 24, 7, 30),
        _utc(2026, 10, 25, 8, 30),
        _utc(2026, 10, 26, 8, 30),
    ]


def test_a_naive_dtstart_is_interpreted_in_the_series_zone() -> None:
    spec = _spec("FREQ=DAILY;COUNT=1", datetime(2026, 1, 2, 9, 30), time_zone=AMSTERDAM)
    assert occurrences(spec) == [_utc(2026, 1, 2, 8, 30)]  # 09:30 CET


def test_an_aware_dtstart_is_converted_into_the_series_zone() -> None:
    spec = _spec("FREQ=DAILY;COUNT=1", _utc(2026, 1, 2, 8, 30), time_zone=AMSTERDAM)
    assert occurrences(spec) == [_utc(2026, 1, 2, 8, 30)]


def test_a_naive_dtstart_without_a_zone_is_utc() -> None:
    spec = _spec("FREQ=DAILY;COUNT=1", datetime(2026, 1, 2, 9, 30))
    assert occurrences(spec) == [_utc(2026, 1, 2, 9, 30)]
    assert spec.dtstart.tzinfo is not None


def test_a_naive_dtstart_in_the_dst_gap_is_rejected() -> None:
    with pytest.raises(NonexistentWallTimeError):
        localize_dtstart(GAP, AMSTERDAM)


def test_an_unknown_series_zone_is_rejected() -> None:
    with pytest.raises(InvalidTimeZoneError):
        localize_dtstart(datetime(2026, 1, 2, 9, 30), "Mars/Phobos")


def test_local_wall_time_survives_a_timezone_conversion() -> None:
    spec = _spec("FREQ=DAILY;COUNT=2", datetime(2026, 1, 2, 9, 30), time_zone=NEW_YORK)
    assert occurrences(spec) == [_utc(2026, 1, 2, 14, 30), _utc(2026, 1, 3, 14, 30)]


# --- Bounds: COUNT / UNTIL / end_date --------------------------------------


def test_count_is_mirrored_from_the_rule() -> None:
    assert series_bounds("FREQ=DAILY;COUNT=5") == (5, None)


def test_until_sets_the_local_end_date_in_the_series_zone() -> None:
    # 23:00Z on 01-10 is 00:00 on 01-11 in Amsterdam (+01:00), so the last local day is 01-11.
    assert series_bounds("FREQ=DAILY;UNTIL=20260110T230000Z", AMSTERDAM)[1] == date(2026, 1, 11)
    # A date-only UNTIL is that calendar day.
    assert series_bounds("FREQ=DAILY;UNTIL=20260110", AMSTERDAM)[1] == date(2026, 1, 10)


def test_until_terminates_the_series() -> None:
    spec = _spec("FREQ=DAILY;UNTIL=20260104T093000Z", _utc(2026, 1, 2, 9, 30))
    assert occurrences(spec) == [
        _utc(2026, 1, 2, 9, 30),
        _utc(2026, 1, 3, 9, 30),
        _utc(2026, 1, 4, 9, 30),
    ]
    assert next_occurrence(spec, after=_utc(2026, 1, 4, 9, 30)) is None


def test_end_date_terminates_the_series() -> None:
    spec = _spec("FREQ=DAILY", _utc(2026, 1, 2, 9, 30), end_date=date(2026, 1, 4))
    assert occurrences(spec) == [
        _utc(2026, 1, 2, 9, 30),
        _utc(2026, 1, 3, 9, 30),
        _utc(2026, 1, 4, 9, 30),
    ]
    assert next_occurrence(spec, after=_utc(2026, 1, 4, 9, 30)) is None


def test_count_and_end_date_whichever_comes_first_wins() -> None:
    by_count = _spec("FREQ=DAILY;COUNT=2", _utc(2026, 1, 2, 9, 30), end_date=date(2026, 1, 31))
    by_end = _spec("FREQ=DAILY;COUNT=99", _utc(2026, 1, 2, 9, 30), end_date=date(2026, 1, 3))
    assert len(occurrences(by_count)) == 2
    assert len(occurrences(by_end)) == 2


# --- Completion semantics (the core rule) ----------------------------------


def test_completing_an_occurrence_generates_exactly_the_next() -> None:
    spec = _spec("FREQ=DAILY;COUNT=3", _utc(2026, 1, 2, 9, 30))
    assert next_occurrence(spec) == _utc(2026, 1, 2, 9, 30)  # the head / first occurrence
    assert next_occurrence(spec, after=_utc(2026, 1, 2, 9, 30)) == _utc(2026, 1, 3, 9, 30)
    assert next_occurrence(spec, after=_utc(2026, 1, 3, 9, 30)) == _utc(2026, 1, 4, 9, 30)


def test_completing_a_later_occurrence_does_not_rewind_the_series() -> None:
    spec = _spec("FREQ=WEEKLY;COUNT=10", datetime(2026, 1, 5, 9, 0), time_zone=AMSTERDAM)
    third = _utc(2026, 1, 19, 8, 0)  # 09:00 CET
    assert next_occurrence(spec, after=third) == _utc(2026, 1, 26, 8, 0)
    # Re-computing never yields an earlier occurrence.
    assert next_occurrence(spec, after=_utc(2026, 1, 3, 0, 0)) == _utc(2026, 1, 5, 8, 0)


def test_completing_the_final_occurrence_stops_the_series() -> None:
    spec = _spec("FREQ=DAILY;COUNT=2", _utc(2026, 1, 2, 9, 30))
    last = _utc(2026, 1, 3, 9, 30)
    assert next_occurrence(spec, after=last) is None


def test_the_series_is_not_mutated_by_reading_it() -> None:
    spec = _spec("FREQ=DAILY;COUNT=3", _utc(2026, 1, 2, 9, 30))
    first_read = occurrences(spec)
    assert next_occurrence(spec, after=_utc(2026, 1, 2, 9, 30)) == _utc(2026, 1, 3, 9, 30)
    assert occurrences(spec) == first_read  # the series definition is unchanged
    assert spec.count == 3
    assert spec.dtstart == _utc(2026, 1, 2, 9, 30)


# --- Invalid rules ---------------------------------------------------------


@pytest.mark.parametrize(
    "rule",
    [
        "",
        "   ",
        "FREQ=NEVER",
        "not a rule",
        "FREQ=DAILY;COUNT=abc",
        "FREQ=DAILY;COUNT=0",
        "FREQ=DAILY;INTERVAL=0",
        "FREQ=WEEKLY;BYDAY=XX",
        "DTSTART:20260101T090000Z",  # dtstart belongs to the task, not the rule
    ],
)
def test_invalid_rules_are_rejected(rule: str) -> None:
    with pytest.raises(InvalidRecurrenceRuleError):
        validate_rule(rule)


def test_validate_rule_returns_the_normalised_text() -> None:
    assert validate_rule(" FREQ=WEEKLY;BYDAY=MO ") == "FREQ=WEEKLY;BYDAY=MO"


def test_an_unknown_rule_never_builds_a_spec() -> None:
    with pytest.raises(InvalidRecurrenceRuleError):
        build_spec("FREQ=NEVER", _utc(2026, 1, 2, 9, 30))


def test_a_weekly_cadence_spans_dst_without_drifting() -> None:
    spec = _spec("FREQ=WEEKLY;COUNT=3", datetime(2026, 3, 23, 9, 0), time_zone=AMSTERDAM)
    # 09:00 CET before the change, 09:00 CEST after; a fixed-offset engine would drift by an hour.
    assert occurrences(spec) == [
        _utc(2026, 3, 23, 8, 0),
        _utc(2026, 3, 30, 7, 0),
        _utc(2026, 4, 6, 7, 0),
    ]
    assert occurrences(spec)[1] - occurrences(spec)[0] == timedelta(hours=167)
