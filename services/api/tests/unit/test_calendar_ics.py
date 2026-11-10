"""ICS parsing (M5-11): zones, all-day, recurrence, overrides, malformed input never crashes."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from atlas.calendar.feed import FeedError
from atlas.calendar.ics import MAX_EVENTS, parse_ics
from atlas.calendar.types import EventStatus

HEAD = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//fixture//EN\r\n"
TAIL = "END:VCALENDAR\r\n"


def feed(*events: str, head: str = HEAD) -> bytes:
    body = head + "".join(f"BEGIN:VEVENT\r\n{e.strip()}\r\nEND:VEVENT\r\n" for e in events) + TAIL
    return body.encode()


def by_summary(parsed):
    return {e.summary: e for e in parsed.events}


def test_timed_utc_floating_and_windows_zone_events() -> None:
    parsed = parse_ics(
        feed(
            "UID:1\r\nDTSTART;TZID=Europe/Berlin:20261110T090000\r\nDTEND;TZID=Europe/Berlin:20261110T100000\r\nSUMMARY:Berlin",
            "UID:2\r\nDTSTART:20261110T120000Z\r\nDURATION:PT90M\r\nSUMMARY:Utc",
            "UID:3\r\nDTSTART:20261110T120000\r\nSUMMARY:Floating",
            "UID:4\r\nDTSTART;TZID=W. Europe Standard Time:20261110T130000\r\nDTEND;TZID=W. Europe Standard Time:20261110T140000\r\nSUMMARY:Windows",
            "UID:5\r\nDTSTART;TZID=Not/AZone:20261110T130000\r\nSUMMARY:Unknown zone",
            head=HEAD + "X-WR-TIMEZONE:Europe/Berlin\r\nX-WR-CALNAME:My feed\r\n",
        ),
        feed_id="f",
    )
    events = by_summary(parsed)
    assert parsed.name == "My feed" and parsed.time_zone == "Europe/Berlin"
    assert events["Berlin"].start == datetime(2026, 11, 10, 8, tzinfo=UTC)
    assert events["Berlin"].time_zone == "Europe/Berlin" and not events["Berlin"].is_all_day
    assert events["Utc"].time_zone == "UTC" and events["Utc"].end == datetime(
        2026, 11, 10, 13, 30, tzinfo=UTC
    )
    # floating times are read in the feed's default zone
    assert events["Floating"].start == datetime(2026, 11, 10, 11, tzinfo=UTC)
    assert events["Windows"].time_zone == "Europe/Berlin"
    assert events["Windows"].start == datetime(2026, 11, 10, 12, tzinfo=UTC)
    assert events["Unknown zone"].time_zone == "Europe/Berlin"


def test_all_day_and_multi_day_events_use_local_midnights() -> None:
    parsed = parse_ics(
        feed(
            "UID:a\r\nDTSTART;VALUE=DATE:20261224\r\nDTEND;VALUE=DATE:20261227\r\nSUMMARY:Holiday",
            "UID:b\r\nDTSTART;VALUE=DATE:20261231\r\nSUMMARY:One day",
            head=HEAD + "X-WR-TIMEZONE:Europe/Berlin\r\n",
        ),
        feed_id="f",
    )
    events = by_summary(parsed)
    holiday = events["Holiday"]
    assert holiday.is_all_day and holiday.start == datetime(2026, 12, 23, 23, tzinfo=UTC)
    assert holiday.end == datetime(2026, 12, 26, 23, tzinfo=UTC)
    assert events["One day"].end - events["One day"].start == datetime(
        2027, 1, 1, tzinfo=UTC
    ) - datetime(2026, 12, 31, tzinfo=UTC)


def test_recurrence_exdate_and_override_are_normalised() -> None:
    parsed = parse_ics(
        feed(
            "UID:r\r\nDTSTART;TZID=Europe/Berlin:20261110T090000\r\nDTEND;TZID=Europe/Berlin:20261110T100000\r\nSUMMARY:Standup\r\n"
            "RRULE:FREQ=DAILY;UNTIL=20261120T080000Z\r\nEXDATE;TZID=Europe/Berlin:20261112T090000",
            "UID:r\r\nRECURRENCE-ID;TZID=Europe/Berlin:20261111T090000\r\nDTSTART;TZID=Europe/Berlin:20261111T110000\r\n"
            "DTEND;TZID=Europe/Berlin:20261111T120000\r\nSUMMARY:Moved",
            "UID:r\r\nRECURRENCE-ID;TZID=Europe/Berlin:20261113T090000\r\nDTSTART;TZID=Europe/Berlin:20261113T090000\r\n"
            "SUMMARY:Cancelled one\r\nSTATUS:CANCELLED",
        ),
        feed_id="f",
    )
    events = by_summary(parsed)
    master, moved, cancelled = events["Standup"], events["Moved"], events["Cancelled one"]
    assert (
        master.recurrence_rule == "RRULE:FREQ=DAILY;UNTIL=20261120T080000Z\nEXDATE:20261112T080000Z"
    )
    assert master.series_id is None and master.recurrence_id is None
    assert moved.series_id == master.id and moved.recurrence_id == "20261111T080000Z"
    assert (
        cancelled.status is EventStatus.CANCELLED and cancelled.recurrence_id == "20261113T080000Z"
    )
    assert len({e.id for e in parsed.events}) == 3


def test_event_ids_are_stable_across_parses_and_change_with_content_only_in_the_etag() -> None:
    a = parse_ics(feed("UID:x\r\nDTSTART:20261110T090000Z\r\nSUMMARY:One"), feed_id="f").events[0]
    b = parse_ics(feed("UID:x\r\nDTSTART:20261110T090000Z\r\nSUMMARY:One"), feed_id="f").events[0]
    c = parse_ics(feed("UID:x\r\nDTSTART:20261110T090000Z\r\nSUMMARY:Two"), feed_id="f").events[0]
    other_feed = parse_ics(
        feed("UID:x\r\nDTSTART:20261110T090000Z\r\nSUMMARY:One"), feed_id="g"
    ).events[0]
    assert a.id == b.id == c.id and a.etag == b.etag and a.etag != c.etag
    assert other_feed.id != a.id  # the same UID in two feeds never collides


def test_malformed_events_are_skipped_and_counted_not_fatal() -> None:
    parsed = parse_ics(
        feed(
            "UID:ok\r\nDTSTART:20261110T090000Z\r\nSUMMARY:Fine",
            "SUMMARY:No uid\r\nDTSTART:20261110T090000Z",
            "UID:nostart\r\nSUMMARY:No start",
            "UID:badrule\r\nDTSTART:20261110T090000Z\r\nSUMMARY:Bad rule\r\nRRULE:FREQ=SECONDLY",
            "UID:inverted\r\nDTSTART:20261110T100000Z\r\nDTEND:20261110T090000Z\r\nSUMMARY:Inverted",
        ),
        feed_id="f",
    )
    events = by_summary(parsed)
    assert set(events) == {"Fine", "Bad rule", "Inverted"} and parsed.skipped == 2
    assert events["Bad rule"].recurrence_rule is None  # the unsafe rule is dropped, the event kept
    assert events["Inverted"].end == events["Inverted"].start


@pytest.mark.parametrize(
    "body",
    [
        b"",
        b"<html><body>Sign in</body></html>",
        b"\x00\x01\x02garbage",
        b"BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x",
    ],
)
def test_a_body_that_is_not_a_calendar_raises_a_safe_error(body: bytes) -> None:
    try:
        parsed = parse_ics(body, feed_id="f")
    except FeedError as exc:
        assert exc.code == "not_calendar"
        assert "BEGIN" not in str(exc) and "html" not in str(exc).lower()
    else:  # a truncated-but-recognisable calendar may parse to nothing; it must not crash
        assert parsed.events == ()


def test_bom_folded_lines_and_oversized_text_are_handled() -> None:
    long_summary = "x" * 5000
    body = (
        "﻿" + HEAD + "BEGIN:VEVENT\r\nUID:1\r\nDTSTART:20261110T090000Z\r\n"
        "SUMMARY:Folded\r\n  continued\r\n"
        f"DESCRIPTION:{long_summary}\r\nEND:VEVENT\r\n" + TAIL
    ).encode()
    event = parse_ics(body, feed_id="f").events[0]
    assert event.summary == "Folded continued"
    assert event.description is not None and len(event.description) <= 4000


def test_too_many_events_are_refused() -> None:
    events = [f"UID:{i}\r\nDTSTART:20261110T090000Z\r\nSUMMARY:e" for i in range(MAX_EVENTS + 1)]
    with pytest.raises(FeedError) as raised:
        parse_ics(feed(*events), feed_id="f")
    assert raised.value.code == "too_large"


def test_urls_are_kept_only_when_http_s_and_never_javascript() -> None:
    parsed = parse_ics(
        feed(
            "UID:1\r\nDTSTART:20261110T090000Z\r\nSUMMARY:a\r\nURL:https://example.test/e/1",
            "UID:2\r\nDTSTART:20261110T090000Z\r\nSUMMARY:b\r\nURL:javascript:alert(1)",
        ),
        feed_id="f",
    )
    events = by_summary(parsed)
    assert events["a"].web_link == "https://example.test/e/1" and events["b"].web_link is None
