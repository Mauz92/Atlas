"""Per-user change feed (M7-01): pure cursor/ordering logic and API contract, no database.

Covers the cursor/limit validation, the page planner and the "merge to the latest change per
entity" rule in ``atlas/changes/feed.py``, plus the ``GET /api/changes`` query surface. The
end-to-end behaviour is covered by ``tests/integration/test_changes_api.py``.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from atlas.changes import (
    DEFAULT_CHANGE_LIMIT,
    MAX_CHANGE_LIMIT,
    MAX_CURSOR,
    ChangeEntityType,
    ChangeOperation,
    FeedChange,
    InvalidChangeCursorError,
    entity_id_for,
    merge_latest,
    note_project_link_id,
    parse_limit,
    parse_since,
    plan_change_page,
)
from atlas.main import create_app

_NOW = datetime(2026, 10, 27, 12, 0, tzinfo=UTC)


def _change(entity_type: str, entity_id: str, operation: str, cursor: int) -> FeedChange:
    return FeedChange(
        entity_type=entity_type,
        entity_id=entity_id,
        operation=operation,
        cursor=cursor,
        changed_at=_NOW,
    )


# --- vocabulary ---------------------------------------------------------------


def test_the_entity_types_match_the_documented_set() -> None:
    assert {member.value for member in ChangeEntityType} == {
        "task",
        "project",
        "note",
        "note_project_link",
        "task_note_link",
        "resolution",
        "reminder",
    }


def test_the_operations_are_upsert_and_delete() -> None:
    assert {member.value for member in ChangeOperation} == {"upsert", "delete"}


def test_a_link_id_is_the_note_and_project_pair() -> None:
    note = "11111111-1111-1111-1111-111111111111"
    project = "22222222-2222-2222-2222-222222222222"
    assert note_project_link_id(note, project) == f"{note}:{project}"
    assert entity_id_for(note) == note


# --- cursor parsing -----------------------------------------------------------


def test_an_absent_cursor_means_the_whole_change_set() -> None:
    assert parse_since(None) == 0
    assert parse_since(0) == 0


def test_a_cursor_is_accepted_up_to_the_64_bit_range() -> None:
    assert parse_since(1) == 1
    assert parse_since(4310) == 4310
    assert parse_since(MAX_CURSOR) == MAX_CURSOR


def test_a_negative_or_over_large_cursor_is_rejected() -> None:
    with pytest.raises(InvalidChangeCursorError):
        parse_since(-1)
    with pytest.raises(InvalidChangeCursorError):
        parse_since(MAX_CURSOR + 1)


# --- limit parsing ------------------------------------------------------------


def test_an_absent_limit_uses_the_default() -> None:
    assert parse_limit(None) == DEFAULT_CHANGE_LIMIT


def test_a_limit_is_accepted_within_bounds() -> None:
    assert parse_limit(1) == 1
    assert parse_limit(MAX_CHANGE_LIMIT) == MAX_CHANGE_LIMIT


def test_an_out_of_range_limit_is_rejected() -> None:
    for value in (0, -5, MAX_CHANGE_LIMIT + 1):
        with pytest.raises(InvalidChangeCursorError):
            parse_limit(value)


# --- page planning ------------------------------------------------------------


def test_an_empty_change_set_delivers_nothing() -> None:
    plan = plan_change_page([], since=0, limit=10)
    assert plan.deliver == 0
    assert plan.next_since == 0
    assert plan.has_more is False


def test_a_cursor_beyond_every_change_delivers_nothing_but_keeps_the_cursor() -> None:
    plan = plan_change_page([], since=7, limit=10)
    assert plan.next_since == 7
    assert plan.has_more is False


def test_a_change_set_that_fits_is_delivered_whole() -> None:
    plan = plan_change_page([1, 2, 5], since=0, limit=10)
    assert plan.deliver == 3
    assert plan.next_since == 5
    assert plan.has_more is False


def test_a_page_that_reaches_the_limit_reports_more_and_stops_at_the_last_delivered() -> None:
    # limit + 1 fetched means at least one more change exists past the page.
    plan = plan_change_page([1, 2, 3], since=0, limit=2)
    assert plan.deliver == 2
    assert plan.next_since == 2
    assert plan.has_more is True


# --- merge: one change per entity, at its latest cursor -----------------------


def test_merge_collapses_an_entity_changed_twice_to_its_latest() -> None:
    merged = merge_latest(
        [
            _change("task", "a", "upsert", 1),
            _change("project", "p", "upsert", 2),
            _change("task", "a", "delete", 9),
        ]
    )
    assert [(c.entity_type, c.entity_id, c.operation, c.cursor) for c in merged] == [
        ("project", "p", "upsert", 2),
        ("task", "a", "delete", 9),
    ]


def test_merge_keeps_distinct_entities_and_orders_by_cursor() -> None:
    merged = merge_latest(
        [
            _change("note", "n", "upsert", 5),
            _change("task", "t", "upsert", 2),
        ]
    )
    assert [c.cursor for c in merged] == [2, 5]


def test_merge_distinguishes_entity_types_with_the_same_id() -> None:
    merged = merge_latest(
        [
            _change("task", "x", "upsert", 1),
            _change("note", "x", "upsert", 2),
        ]
    )
    assert {(c.entity_type, c.entity_id) for c in merged} == {("task", "x"), ("note", "x")}


# --- paging covers the whole change set exactly once --------------------------


def _page(cursors: list[int], since: int, limit: int) -> tuple[list[int], int, bool]:
    """Mimic the service's one-page algorithm over a plain cursor list (no database)."""
    ordered = sorted(cursor for cursor in cursors if cursor > since)
    window = ordered[: limit + 1]
    plan = plan_change_page(window, since=since, limit=limit)
    return window[: plan.deliver], plan.next_since, plan.has_more


def _drain(cursors: list[int], limit: int) -> list[int]:
    """Page through the change set until ``has_more`` is false, collecting every cursor seen."""
    seen: list[int] = []
    since = 0
    for _ in range(len(cursors) + 3):
        page, since, has_more = _page(cursors, since, limit)
        assert page == sorted(page)  # each page is ordered by cursor ascending
        seen.extend(page)
        if not has_more:
            assert _page(cursors, since, limit)[0] == []
            return seen
    raise AssertionError("paging did not converge")


@pytest.mark.parametrize("limit", [1, 2, 3, 4, 200])
def test_paging_covers_every_cursor_once_with_no_gaps_or_duplicates(limit: int) -> None:
    # Cursors are unique per user (the store's unique constraint), so ordering by cursor is total.
    cursors = [1, 2, 3, 4, 5, 8, 12, 20, 21, 34]
    seen = _drain(cursors, limit)
    assert sorted(seen) == sorted(cursors)
    assert len(seen) == len(cursors)  # no duplicates


def test_a_change_bumped_twice_between_pulls_is_seen_once_at_its_latest_cursor() -> None:
    # First pull sees the entity at cursor 1; it is bumped to 9 before the second pull.
    first, cursor, has_more = _page([1], 0, 10)
    assert first == [1]
    assert has_more is False
    second, cursor, has_more = _page([9], cursor, 10)
    assert second == [9]
    assert has_more is False


# --- API contract -------------------------------------------------------------


def _changes_operation() -> dict:
    return create_app().openapi()["paths"]["/api/changes"]["get"]


def test_the_changes_route_is_registered_as_a_read() -> None:
    paths = create_app().openapi()["paths"]
    assert set(paths["/api/changes"]) == {"get"}


def test_since_and_limit_are_optional_query_integers() -> None:
    parameters = {p["name"]: p for p in _changes_operation().get("parameters", [])}
    assert set(parameters) >= {"since", "limit"}
    for name in ("since", "limit"):
        assert parameters[name]["in"] == "query"
        assert parameters[name]["required"] is False


def test_the_response_schema_carries_the_cursor_and_the_rollup_fields() -> None:
    schemas = create_app().openapi()["components"]["schemas"]
    properties = schemas["ChangesOut"]["properties"]
    assert {"changes", "since", "next_since", "has_more"} <= set(properties)
    change = schemas["ChangeOut"]["properties"]
    assert {"entity_type", "entity_id", "operation", "cursor", "changed_at"} <= set(change)
