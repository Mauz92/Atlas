"""Pure projection/merge logic (M5-06).

No database and no adapter: these exercise :mod:`atlas.calendar.projection` — mapping a neutral
:class:`~atlas.calendar.types.Event` to the ``external_events`` columns and the "would this re-sync
change anything?" rule that keeps re-applies idempotent.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from atlas.calendar import (
    Event,
    EventStatus,
    ProjectionState,
    event_is_unchanged,
    merge_event_row,
    projected_values,
)

UPDATED = datetime(2026, 10, 27, 8, 0, tzinfo=UTC)
START = datetime(2026, 10, 27, 9, 0, tzinfo=UTC)
USER_ID = uuid.uuid4()


def _event(event_id: str = "e1", **overrides: object) -> Event:
    fields: dict[str, object] = {
        "id": event_id,
        "calendar_id": "cal-primary",
        "provider": "google",
        "summary": "Standup",
        "start": START,
        "end": START + timedelta(hours=1),
        "time_zone": "Europe/Berlin",
        "updated": UPDATED,
        "etag": "etag-1",
    }
    fields.update(overrides)
    return Event(**fields)  # type: ignore[arg-type]


def _state(**overrides: object) -> ProjectionState:
    fields: dict[str, object] = {
        "etag": "etag-1",
        "source_updated_at": UPDATED,
        "deleted_at": None,
    }
    fields.update(overrides)
    return ProjectionState(**fields)  # type: ignore[arg-type]


# --- projection mapping ----------------------------------------------------


def test_projected_values_maps_every_provider_field() -> None:
    event = _event(
        "series-1",
        summary="Sprint review",
        is_all_day=True,
        status=EventStatus.TENTATIVE,
        etag="etag-9",
        ical_uid="series-1@atlas",
        recurrence_id="2026-10-27",
        recurrence_rule="FREQ=DAILY;COUNT=5",
    )
    values = projected_values(event)
    assert values["provider"] == "google"
    assert values["external_event_id"] == "series-1"
    assert values["calendar_id"] == "cal-primary"
    assert values["summary"] == "Sprint review"
    assert values["start_at"] == START
    assert values["end_at"] == START + timedelta(hours=1)
    assert values["time_zone"] == "Europe/Berlin"
    assert values["is_all_day"] is True
    assert values["status"] == "tentative"
    assert values["etag"] == "etag-9"
    assert values["ical_uid"] == "series-1@atlas"
    assert values["recurrence_id"] == "2026-10-27"
    assert values["recurrence_rule"] == "FREQ=DAILY;COUNT=5"
    assert values["source_updated_at"] == UPDATED


def test_projected_values_carries_a_null_summary_and_status_value() -> None:
    values = projected_values(_event(summary=None, status=EventStatus.CANCELLED))
    assert values["summary"] is None
    assert values["status"] == "cancelled"


def test_merge_event_row_adds_identity_and_clears_the_tombstone() -> None:
    row = merge_event_row(_event(), user_id=USER_ID, last_synced_at=UPDATED)
    assert row["user_id"] == USER_ID
    assert row["last_synced_at"] == UPDATED
    assert row["deleted_at"] is None
    assert isinstance(row["id"], uuid.UUID)
    # Two rows for the same event never share an id (the ON CONFLICT clause keeps the stored one).
    assert merge_event_row(_event(), user_id=USER_ID, last_synced_at=UPDATED)["id"] != row["id"]


# --- the idempotency rule --------------------------------------------------


def test_a_missing_row_always_needs_a_write() -> None:
    assert event_is_unchanged(None, _event()) is False


def test_the_same_etag_and_updated_is_unchanged() -> None:
    assert event_is_unchanged(_state(), _event()) is True


def test_a_different_etag_is_a_change_even_at_the_same_instant() -> None:
    assert event_is_unchanged(_state(etag="etag-1"), _event(etag="etag-2")) is False


def test_a_moved_updated_instant_without_an_etag_is_a_change() -> None:
    later = UPDATED + timedelta(minutes=5)
    assert event_is_unchanged(_state(etag=None), _event(etag=None)) is True
    assert event_is_unchanged(_state(etag=None), _event(etag=None, updated=later)) is False


def test_a_tombstoned_row_is_never_unchanged() -> None:
    # Re-seeing a previously deleted event must revive it.
    assert event_is_unchanged(_state(deleted_at=UPDATED), _event()) is False
