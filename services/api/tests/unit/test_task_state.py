"""Task status state machine (M3-03): pure logic, no database."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from atlas.models import TaskStatus
from atlas.tasks.state import (
    ARCHIVED,
    COMPLETED,
    IN_PROGRESS,
    INBOX,
    NEXT,
    TRANSITIONS,
    InvalidTaskTransitionError,
    allowed_transitions,
    can_transition,
    transition_fields,
    validate_transition,
)

ALL_STATUSES = {status.value for status in TaskStatus}

EXPECTED: dict[str, set[str]] = {
    INBOX: {NEXT, IN_PROGRESS, COMPLETED, ARCHIVED},
    NEXT: {INBOX, IN_PROGRESS, COMPLETED, ARCHIVED},
    IN_PROGRESS: {INBOX, NEXT, COMPLETED, ARCHIVED},
    COMPLETED: {IN_PROGRESS, ARCHIVED},
    ARCHIVED: {INBOX, NEXT},
}

NOW = datetime(2026, 1, 2, 9, 30, tzinfo=UTC)


def test_every_status_has_an_entry() -> None:
    assert set(TRANSITIONS) == ALL_STATUSES


def test_transition_matrix_matches_the_documented_rules() -> None:
    assert {status: set(targets) for status, targets in TRANSITIONS.items()} == EXPECTED


@pytest.mark.parametrize("current", sorted(EXPECTED))
def test_every_allowed_transition_is_accepted(current: str) -> None:
    assert allowed_transitions(current) == frozenset(EXPECTED[current])
    for target in EXPECTED[current]:
        assert can_transition(current, target) is True
        validate_transition(current, target)  # does not raise


@pytest.mark.parametrize("status", sorted(ALL_STATUSES))
def test_a_status_is_never_its_own_successor(status: str) -> None:
    assert can_transition(status, status) is False
    with pytest.raises(InvalidTaskTransitionError):
        validate_transition(status, status)


@pytest.mark.parametrize(
    ("current", "requested"),
    [
        (COMPLETED, INBOX),
        (COMPLETED, NEXT),
        (ARCHIVED, IN_PROGRESS),
        (ARCHIVED, COMPLETED),
    ],
)
def test_disallowed_transitions_are_rejected(current: str, requested: str) -> None:
    assert can_transition(current, requested) is False
    with pytest.raises(InvalidTaskTransitionError) as excinfo:
        validate_transition(current, requested)
    assert excinfo.value.current == current
    assert excinfo.value.requested == requested


def test_unknown_status_has_no_transitions() -> None:
    assert allowed_transitions("nonsense") == frozenset()
    with pytest.raises(InvalidTaskTransitionError):
        validate_transition("nonsense", INBOX)


def test_error_reports_the_allowed_targets() -> None:
    with pytest.raises(InvalidTaskTransitionError) as excinfo:
        validate_transition(ARCHIVED, COMPLETED)
    assert excinfo.value.allowed == frozenset({INBOX, NEXT})


def test_entering_completed_records_the_time() -> None:
    assert transition_fields(IN_PROGRESS, COMPLETED, now=NOW) == {"completed_at": NOW}
    assert transition_fields(NEXT, COMPLETED, now=NOW) == {"completed_at": NOW}


def test_leaving_completed_clears_the_time() -> None:
    assert transition_fields(COMPLETED, IN_PROGRESS, now=NOW) == {"completed_at": None}
    assert transition_fields(COMPLETED, ARCHIVED, now=NOW) == {"completed_at": None}


def test_other_transitions_have_no_side_effects() -> None:
    assert transition_fields(INBOX, NEXT, now=NOW) == {}
    assert transition_fields(NEXT, IN_PROGRESS, now=NOW) == {}
    assert transition_fields(ARCHIVED, INBOX, now=NOW) == {}


def test_creating_a_completed_task_records_the_time() -> None:
    assert transition_fields(None, COMPLETED, now=NOW) == {"completed_at": NOW}
    assert transition_fields(None, INBOX, now=NOW) == {}
