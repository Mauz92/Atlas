"""Periodic reconciliation selection + running-marker rules (M5-10) — pure, no database/network.

The scan's *decisions* (which calendars are due; whether a durable marker is a live run) are pure
functions of the durable cursor columns, so they can be pinned without a database, an adapter or a
clock. The DB-backed and durable-queue behaviour lives in
``tests/integration/test_calendar_reconcile.py``.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from atlas.calendar import (
    CalendarDueState,
    SyncState,
    classify_cursor,
    is_due,
    last_terminal_at,
    marker_is_active,
    rollup_provider,
)
from atlas.calendar.status import CalendarSyncStatus, CursorHealth

NOW = datetime(2026, 10, 27, 12, 0, tzinfo=UTC)
INTERVAL = 300
STALE = 900


# --- last_terminal_at ------------------------------------------------------


def test_last_terminal_at_is_the_most_recent_conclusive_outcome() -> None:
    earlier = NOW - timedelta(minutes=5)
    assert last_terminal_at(earlier, NOW) == NOW
    assert last_terminal_at(NOW, earlier) == NOW
    assert last_terminal_at(NOW, None) == NOW
    assert last_terminal_at(None, None) is None


# --- marker_is_active ------------------------------------------------------


def test_no_marker_is_never_active() -> None:
    assert marker_is_active(None, None, now=NOW, stale_seconds=STALE) is False


def test_a_fresh_marker_with_no_later_outcome_is_active() -> None:
    started = NOW - timedelta(seconds=30)
    assert marker_is_active(started, None, now=NOW, stale_seconds=STALE) is True


def test_a_stale_marker_is_not_active_so_a_crashed_run_cannot_lie() -> None:
    started = NOW - timedelta(seconds=STALE + 1)
    assert marker_is_active(started, None, now=NOW, stale_seconds=STALE) is False


def test_a_marker_whose_run_already_concluded_is_not_active() -> None:
    started = NOW - timedelta(seconds=30)
    assert (
        marker_is_active(started, started + timedelta(seconds=1), now=NOW, stale_seconds=STALE)
        is False
    )
    assert marker_is_active(started, started, now=NOW, stale_seconds=STALE) is False


# --- is_due ----------------------------------------------------------------


def test_a_never_synced_calendar_is_due() -> None:
    assert (
        is_due(
            CalendarDueState(calendar_id="c"),
            now=NOW,
            interval_seconds=INTERVAL,
            stale_seconds=STALE,
        )
        is True
    )


def test_a_recent_success_is_not_due() -> None:
    state = CalendarDueState(calendar_id="c", last_success_at=NOW - timedelta(seconds=60))
    assert is_due(state, now=NOW, interval_seconds=INTERVAL, stale_seconds=STALE) is False


def test_a_success_older_than_the_interval_is_due() -> None:
    state = CalendarDueState(calendar_id="c", last_success_at=NOW - timedelta(seconds=INTERVAL + 1))
    assert is_due(state, now=NOW, interval_seconds=INTERVAL, stale_seconds=STALE) is True


def test_a_calendar_at_exactly_the_interval_is_due() -> None:
    state = CalendarDueState(calendar_id="c", last_success_at=NOW - timedelta(seconds=INTERVAL))
    assert is_due(state, now=NOW, interval_seconds=INTERVAL, stale_seconds=STALE) is True


def test_a_recorded_error_makes_the_calendar_due_even_after_a_recent_success() -> None:
    state = CalendarDueState(
        calendar_id="c",
        last_success_at=NOW - timedelta(seconds=60),
        last_error="provider 503",
        last_error_at=NOW - timedelta(seconds=30),
    )
    assert is_due(state, now=NOW, interval_seconds=INTERVAL, stale_seconds=STALE) is True


def test_a_live_run_is_not_due_again() -> None:
    state = CalendarDueState(calendar_id="c", sync_started_at=NOW - timedelta(seconds=30))
    assert is_due(state, now=NOW, interval_seconds=INTERVAL, stale_seconds=STALE) is False


def test_a_stale_marker_makes_the_calendar_due_so_the_run_is_recovered() -> None:
    state = CalendarDueState(calendar_id="c", sync_started_at=NOW - timedelta(seconds=STALE + 1))
    assert is_due(state, now=NOW, interval_seconds=INTERVAL, stale_seconds=STALE) is True


# --- status derivation: in_progress ---------------------------------------


def test_classify_cursor_reports_in_progress_when_a_run_is_underway() -> None:
    state, health = classify_cursor(
        has_cursor=True, last_success_at=NOW - timedelta(hours=1), last_error=None, in_progress=True
    )
    assert state is SyncState.IN_PROGRESS
    assert health is CursorHealth.OK


def test_classify_cursor_in_progress_before_a_baseline_still_has_missing_health() -> None:
    state, health = classify_cursor(
        has_cursor=False, last_success_at=None, last_error=None, in_progress=True
    )
    assert state is SyncState.IN_PROGRESS
    assert health is CursorHealth.MISSING


def test_in_progress_takes_precedence_over_a_previous_error() -> None:
    state, health = classify_cursor(
        has_cursor=True, last_success_at=None, last_error="previous", in_progress=True
    )
    assert state is SyncState.IN_PROGRESS
    assert health is CursorHealth.OK


def _calendar(calendar_id: str, state: SyncState) -> CalendarSyncStatus:
    return CalendarSyncStatus(
        calendar_id=calendar_id,
        state=state,
        cursor_health=CursorHealth.OK,
        cursor_type="sync_token",
        has_cursor=True,
        last_success_at=NOW,
        last_error=None,
        last_error_at=None,
    )


def test_rollup_reports_in_progress_when_a_calendar_is_syncing_and_none_failed() -> None:
    state, _, _, _ = rollup_provider(
        [_calendar("a", SyncState.IDLE), _calendar("b", SyncState.IN_PROGRESS)]
    )
    assert state is SyncState.IN_PROGRESS


def test_rollup_prefers_an_error_over_a_concurrent_in_progress() -> None:
    state, _, _, _ = rollup_provider(
        [_calendar("a", SyncState.IN_PROGRESS), _calendar("b", SyncState.ERROR)]
    )
    assert state is SyncState.ERROR
