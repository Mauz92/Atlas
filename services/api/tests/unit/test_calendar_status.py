"""Sync-status derivation (M5-08) — pure functions, no database or network.

The read model is a pure function of the M5-06 cursor columns (``last_success_at``/``last_error``/
``cursor_value``), so the derivation can be pinned without a database. The DB-backed and
over-HTTP behaviour lives in ``tests/integration/test_calendar_sync_status_api.py``.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from atlas.calendar import (
    CalendarSyncStatus,
    CursorHealth,
    SyncState,
    classify_cursor,
    rollup_provider,
)

SUCCESS = datetime(2026, 10, 27, 9, 0, tzinfo=UTC)
LATER = SUCCESS + timedelta(hours=1)


def _calendar(
    calendar_id: str,
    *,
    has_cursor: bool = True,
    last_success_at: datetime | None = SUCCESS,
    last_error: str | None = None,
    last_error_at: datetime | None = None,
) -> CalendarSyncStatus:
    state, health = classify_cursor(
        has_cursor=has_cursor, last_success_at=last_success_at, last_error=last_error
    )
    return CalendarSyncStatus(
        calendar_id=calendar_id,
        state=state,
        cursor_health=health,
        cursor_type="sync_token",
        has_cursor=has_cursor,
        last_success_at=last_success_at,
        last_error=last_error,
        last_error_at=last_error_at,
    )


# --- classify_cursor -------------------------------------------------------


def test_a_recorded_error_makes_the_state_error() -> None:
    state, health = classify_cursor(
        has_cursor=True, last_success_at=SUCCESS, last_error="provider 503"
    )
    assert state is SyncState.ERROR
    assert health is CursorHealth.ERROR


def test_a_success_with_a_cursor_is_idle_and_ok() -> None:
    state, health = classify_cursor(has_cursor=True, last_success_at=SUCCESS, last_error=None)
    assert state is SyncState.IDLE
    assert health is CursorHealth.OK


def test_a_success_without_a_cursor_is_idle_but_missing_health() -> None:
    state, health = classify_cursor(has_cursor=False, last_success_at=SUCCESS, last_error=None)
    assert state is SyncState.IDLE
    assert health is CursorHealth.MISSING


def test_no_success_and_no_error_is_never_synced() -> None:
    state, health = classify_cursor(has_cursor=False, last_success_at=None, last_error=None)
    assert state is SyncState.NEVER_SYNCED
    assert health is CursorHealth.MISSING


def test_an_error_without_any_success_is_still_error() -> None:
    # A cursor row can exist recording only an error, before any successful baseline (ADR-0029).
    state, health = classify_cursor(has_cursor=False, last_success_at=None, last_error="boom")
    assert state is SyncState.ERROR
    assert health is CursorHealth.ERROR


# --- rollup_provider -------------------------------------------------------


def test_rollup_of_no_calendars_is_never_synced() -> None:
    assert rollup_provider(()) == (SyncState.NEVER_SYNCED, None, None, None)


def test_any_failing_calendar_makes_the_provider_error() -> None:
    calendars = [
        _calendar("a"),
        _calendar("b", last_success_at=None, last_error="provider 429", last_error_at=LATER),
    ]
    state, last_success, last_error, last_error_at = rollup_provider(calendars)
    assert state is SyncState.ERROR
    assert last_success == SUCCESS  # the healthy calendar's success is still reported
    assert last_error == "provider 429"
    assert last_error_at == LATER


def test_a_provider_with_any_success_is_idle() -> None:
    state, last_success, last_error, _ = rollup_provider(
        [_calendar("a"), _calendar("b", has_cursor=False, last_success_at=None)]
    )
    assert state is SyncState.IDLE
    assert last_success == SUCCESS
    assert last_error is None


def test_rollup_reports_the_most_recent_error() -> None:
    older = _calendar("a", last_success_at=None, last_error="old", last_error_at=SUCCESS)
    newer = _calendar("b", last_success_at=None, last_error="new", last_error_at=LATER)
    _, _, last_error, last_error_at = rollup_provider([older, newer])
    assert last_error == "new"
    assert last_error_at == LATER
