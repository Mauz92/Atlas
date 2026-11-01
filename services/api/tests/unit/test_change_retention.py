"""Change-feed retention (M7-02): the pure window / floor / resync rules, no database.

Covers ``atlas/changes/retention.py`` (the cutoff arithmetic and the resync test), the default
retention setting, the backwards-compatible ``ChangeSet`` default and the ``GET /api/changes``
contract's ``resync_required`` field. The end-to-end purge/resync behaviour is covered by
``tests/integration/test_change_purge.py``.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from atlas.changes import (
    DEFAULT_RETENTION_DAYS,
    ChangeSet,
    InvalidRetentionError,
    resync_required,
    retention_cutoff,
)
from atlas.config import Settings
from atlas.main import create_app

_NOW = datetime(2026, 10, 27, 12, 0, tzinfo=UTC)


# --- the retention window -----------------------------------------------------


def test_the_default_retention_window_is_thirty_days() -> None:
    assert DEFAULT_RETENTION_DAYS == 30
    assert Settings.model_fields["change_retention_days"].default == DEFAULT_RETENTION_DAYS


def test_the_cutoff_is_the_window_before_now() -> None:
    assert retention_cutoff(_NOW, 30) == _NOW - timedelta(days=30)
    assert retention_cutoff(_NOW, 1) == _NOW - timedelta(days=1)


def test_a_non_positive_retention_window_is_rejected() -> None:
    for days in (0, -1, -30):
        with pytest.raises(InvalidRetentionError):
            retention_cutoff(_NOW, days)


def test_the_configured_retention_days_must_be_positive() -> None:
    # The settings validator fails fast rather than letting every purge job fail at run time.
    with pytest.raises(ValueError):
        Settings(change_retention_days=0)


# --- the purge floor and the resync signal ------------------------------------


def test_a_cursor_below_the_floor_requires_a_resync() -> None:
    # The changes in (0, 5] were purged and can never be delivered.
    assert resync_required(0, 5) is True
    assert resync_required(4, 5) is True


def test_a_cursor_at_or_above_the_floor_is_served_incrementally() -> None:
    # The floor is the highest purged cursor; everything after it is still retained.
    assert resync_required(5, 5) is False
    assert resync_required(6, 5) is False
    assert resync_required(100, 5) is False


def test_nothing_is_purged_so_no_cursor_ever_needs_a_resync() -> None:
    assert resync_required(0, 0) is False
    assert resync_required(42, 0) is False


# --- the change set default ---------------------------------------------------


def test_a_change_set_is_incremental_by_default() -> None:
    change_set = ChangeSet(changes=[], next_since=7, has_more=False)
    assert change_set.resync_required is False


# --- API contract -------------------------------------------------------------


def test_the_changes_response_carries_the_resync_flag() -> None:
    schemas = create_app().openapi()["components"]["schemas"]
    properties = schemas["ChangesOut"]["properties"]
    assert "resync_required" in properties
    assert properties["resync_required"]["default"] is False
