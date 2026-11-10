"""Recurrence expansion: DST, all-day, EXDATE/UNTIL, bounds and property-style invariants (M5-07)."""

from __future__ import annotations

import random
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from atlas.calendar.recurrence import (
    MAX_OCCURRENCES,
    expand_series,
    local_dates,
    occurrence_key,
    parse_rules,
    rule_is_supported,
)

BERLIN = ZoneInfo("Europe/Berlin")


def utc(*args: int) -> datetime:
    return datetime(*args, tzinfo=UTC)


def berlin(*args: int) -> datetime:
    return datetime(*args, tzinfo=BERLIN).astimezone(UTC)


def expand(start, end, rules, ws, we, *, zone="Europe/Berlin", all_day=False):
    return expand_series(
        start=start,
        end=end,
        zone_name=zone,
        is_all_day=all_day,
        rules_text=rules,
        window_start=ws,
        window_end=we,
    )


def test_a_daily_series_keeps_its_local_wall_clock_across_the_autumn_dst_change() -> None:
    # 09:00 Berlin daily from Sat 2026-10-24; clocks go back on Sun 2026-10-25 03:00 -> 02:00.
    start = berlin(2026, 10, 24, 9)
    out = expand(
        start,
        start + timedelta(hours=1),
        "RRULE:FREQ=DAILY;COUNT=4",
        utc(2026, 10, 1),
        utc(2026, 12, 1),
    )
    local = [s.astimezone(BERLIN) for s, _ in out]
    assert [(d.day, d.hour) for d in local] == [(24, 9), (25, 9), (26, 9), (27, 9)]
    # the UTC instant moved by one hour at the change, the wall clock did not
    assert out[0][0].hour == 7 and out[1][0].hour == 8


def test_a_spring_forward_gap_resolves_deterministically() -> None:
    # 02:30 does not exist on 2026-03-29 in Berlin; zoneinfo fold=0 -> interpreted with the old offset.
    start = berlin(2026, 3, 28, 2, 30)
    out = expand(
        start,
        start + timedelta(hours=1),
        "RRULE:FREQ=DAILY;COUNT=3",
        utc(2026, 3, 1),
        utc(2026, 4, 30),
    )
    assert len(out) == 3
    again = expand(
        start,
        start + timedelta(hours=1),
        "RRULE:FREQ=DAILY;COUNT=3",
        utc(2026, 3, 1),
        utc(2026, 4, 30),
    )
    assert out == again
    assert [s.astimezone(BERLIN).day for s, _ in out] == [28, 29, 30]


def test_all_day_series_expand_as_local_dates_and_keep_their_length() -> None:
    start = datetime(2026, 12, 23, 23, tzinfo=UTC)  # 2026-12-24 00:00 Berlin
    end = start + timedelta(days=2)
    out = expand(
        start, end, "RRULE:FREQ=YEARLY;COUNT=3", utc(2026, 1, 1), utc(2030, 1, 1), all_day=True
    )
    assert [local_dates(s, e, "Europe/Berlin")[0].year for s, e in out] == [2026, 2027, 2028]
    for s, e in out:
        first, last = local_dates(s, e, "Europe/Berlin")
        assert (first.month, first.day) == (12, 24) and (last - first).days == 2


def test_exdate_removes_that_occurrence_only() -> None:
    start = berlin(2026, 11, 10, 9)
    rules = "RRULE:FREQ=DAILY;COUNT=4\n" + "EXDATE:" + occurrence_key(berlin(2026, 11, 12, 9))
    out = expand(start, start + timedelta(hours=1), rules, utc(2026, 11, 1), utc(2026, 12, 1))
    assert [s.astimezone(BERLIN).day for s, _ in out] == [10, 11, 13]


def test_rdate_adds_an_occurrence() -> None:
    start = berlin(2026, 11, 10, 9)
    rules = "RRULE:FREQ=WEEKLY;COUNT=2\nRDATE:" + occurrence_key(berlin(2026, 11, 12, 15))
    out = expand(start, start + timedelta(hours=1), rules, utc(2026, 11, 1), utc(2026, 12, 1))
    assert [(s.astimezone(BERLIN).day, s.astimezone(BERLIN).hour) for s, _ in out] == [
        (10, 9),
        (12, 15),
        (17, 9),
    ]


@pytest.mark.parametrize(
    "until", ["UNTIL=20261112T080000Z", "UNTIL=20261112", "UNTIL=20261112T090000"]
)
def test_until_in_utc_date_and_floating_forms_is_inclusive_in_local_time(until: str) -> None:
    start = berlin(2026, 11, 10, 9)
    out = expand(
        start,
        start + timedelta(hours=1),
        f"RRULE:FREQ=DAILY;{until}",
        utc(2026, 11, 1),
        utc(2026, 12, 1),
    )
    assert [s.astimezone(BERLIN).day for s, _ in out] == [10, 11, 12]


def test_only_occurrences_overlapping_the_window_are_returned() -> None:
    start = berlin(2026, 1, 5, 22)
    out = expand(
        start,
        start + timedelta(hours=4),
        "RRULE:FREQ=DAILY",
        berlin(2026, 6, 10, 0),
        berlin(2026, 6, 12, 0),
    )
    # an occurrence starting 22:00 on the 9th still overlaps 00:00 on the 10th (ends 02:00)
    days = [s.astimezone(BERLIN).day for s, _ in out]
    assert days == [9, 10, 11]


def test_an_unusable_rule_degrades_to_the_master_occurrence() -> None:
    start = utc(2026, 11, 10, 9)
    out = expand(
        start,
        start + timedelta(hours=1),
        "RRULE:FREQ=NONSENSE",
        utc(2026, 11, 1),
        utc(2026, 12, 1),
        zone="UTC",
    )
    assert out == [(start, start + timedelta(hours=1))]


@pytest.mark.parametrize("rule", ["FREQ=SECONDLY", "FREQ=MINUTELY;INTERVAL=5", "FREQ=", "garbage"])
def test_rules_finer_than_hourly_or_invalid_are_refused(rule: str) -> None:
    assert not rule_is_supported(rule)


def test_an_unbounded_hourly_rule_is_capped() -> None:
    start = utc(2020, 1, 1)
    out = expand(
        start,
        start + timedelta(minutes=30),
        "RRULE:FREQ=HOURLY",
        utc(2020, 1, 1),
        utc(2020, 6, 1),
        zone="UTC",
    )
    assert len(out) == MAX_OCCURRENCES


def test_parse_rules_ignores_garbage_lines() -> None:
    parsed = parse_rules("RRULE:FREQ=DAILY\nnonsense\nEXDATE:bad,20261112T080000Z\nRDATE:")
    assert parsed.rrules == ("FREQ=DAILY",)
    assert len(parsed.exdates) == 1 and not parsed.rdates


@pytest.mark.parametrize("seed", range(40))
def test_property_daily_occurrences_keep_wall_clock_and_are_sorted_and_unique(seed: int) -> None:
    rng = random.Random(seed)
    zone_name = rng.choice(
        ["Europe/Berlin", "America/New_York", "Australia/Sydney", "Asia/Kolkata", "UTC"]
    )
    zone = ZoneInfo(zone_name)
    first_local = datetime(
        2026,
        rng.randint(1, 12),
        rng.randint(1, 28),
        rng.choice([0, 6, 9, 12, 18, 23]),
        rng.choice([0, 15, 45]),
    )
    start = first_local.replace(tzinfo=zone).astimezone(UTC)
    count = rng.randint(1, 60)
    out = expand(
        start,
        start + timedelta(minutes=45),
        f"RRULE:FREQ=DAILY;COUNT={count}",
        utc(2025, 1, 1),
        utc(2028, 1, 1),
        zone=zone_name,
    )
    assert len(out) == count
    starts = [s for s, _ in out]
    assert starts == sorted(starts) and len(set(starts)) == count
    for s, e in out:
        assert e - s == timedelta(minutes=45)
        local = s.astimezone(zone)
        # wall clock preserved unless the local time falls in a DST gap (then zoneinfo shifts it)
        in_gap = zone.utcoffset(local.replace(tzinfo=None)) != local.utcoffset()
        if not in_gap:
            assert (local.hour, local.minute) == (first_local.hour, first_local.minute)


@pytest.mark.parametrize("seed", range(25))
def test_property_weekly_by_day_matches_a_brute_force_calendar_walk(seed: int) -> None:
    rng = random.Random(1000 + seed)
    days = sorted(rng.sample(["MO", "TU", "WE", "TH", "FR", "SA", "SU"], rng.randint(1, 4)))
    start = berlin(2026, rng.randint(1, 11), rng.randint(1, 20), 9)
    window_start, window_end = start - timedelta(days=3), start + timedelta(days=70)
    out = expand(
        start,
        start + timedelta(hours=1),
        f"RRULE:FREQ=WEEKLY;BYDAY={','.join(days)}",
        window_start,
        window_end,
    )
    names = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]
    expected = []
    day = start.astimezone(BERLIN).date()
    while day <= window_end.astimezone(BERLIN).date():
        if names[day.weekday()] in days:
            moment = datetime(day.year, day.month, day.day, 9, tzinfo=BERLIN).astimezone(UTC)
            if start <= moment < window_end:
                expected.append(moment)
        day += timedelta(days=1)
    # dateutil includes DTSTART itself even when it is not on a BYDAY (RFC 5545 section 3.8.5.3)
    if start not in expected:
        expected.append(start)
    assert [s for s, _ in out] == sorted(set(expected))
