"""Task change log / incremental pull (M3-09): pure logic and API contract, no database.

Covers the cursor/limit validation and the paging planner in ``atlas/tasks/changes.py`` — the rule
that guarantees a page never splits a run of equal revisions — and the ``GET /api/tasks/changes``
query surface. The end-to-end behaviour is covered by
``tests/integration/test_tasks_changes.py``.
"""

from __future__ import annotations

import pytest

from atlas.main import create_app
from atlas.tasks import (
    DEFAULT_CHANGE_LIMIT,
    MAX_CHANGE_LIMIT,
    MAX_SINCE,
    ChangePagePlan,
    InvalidTaskFilterError,
    parse_change_limit,
    parse_since,
    plan_change_page,
)

# --- cursor parsing -----------------------------------------------------------


def test_an_absent_cursor_means_the_whole_change_set() -> None:
    assert parse_since(None) == 0
    assert parse_since(0) == 0


def test_a_cursor_is_accepted_up_to_the_revision_range() -> None:
    assert parse_since(1) == 1
    assert parse_since(4310) == 4310
    assert parse_since(MAX_SINCE) == MAX_SINCE


def test_a_negative_or_over_large_cursor_is_rejected() -> None:
    with pytest.raises(InvalidTaskFilterError):
        parse_since(-1)
    with pytest.raises(InvalidTaskFilterError):
        parse_since(MAX_SINCE + 1)


# --- limit parsing ------------------------------------------------------------


def test_an_absent_limit_uses_the_default() -> None:
    assert parse_change_limit(None) == DEFAULT_CHANGE_LIMIT


def test_a_limit_is_accepted_within_bounds() -> None:
    assert parse_change_limit(1) == 1
    assert parse_change_limit(MAX_CHANGE_LIMIT) == MAX_CHANGE_LIMIT


def test_an_out_of_range_limit_is_rejected() -> None:
    with pytest.raises(InvalidTaskFilterError):
        parse_change_limit(0)
    with pytest.raises(InvalidTaskFilterError):
        parse_change_limit(-5)
    with pytest.raises(InvalidTaskFilterError):
        parse_change_limit(MAX_CHANGE_LIMIT + 1)


# --- page planning ------------------------------------------------------------


def test_an_empty_change_set_delivers_nothing() -> None:
    plan = plan_change_page([], since=0, limit=10)
    assert plan == ChangePagePlan(deliver=0, next_since=0, has_more=False)


def test_a_change_set_that_fits_is_delivered_whole() -> None:
    plan = plan_change_page([1, 1, 2], since=0, limit=10)
    assert plan.deliver == 3
    assert plan.next_since == 2
    assert plan.has_more is False
    assert plan.complete_group is None


def test_a_page_that_ends_at_a_revision_boundary_stops_there() -> None:
    # The third row belongs to a higher revision, so the first two are a safe prefix.
    plan = plan_change_page([1, 1, 3], since=0, limit=2)
    assert plan.deliver == 2
    assert plan.next_since == 1
    assert plan.has_more is True


def test_a_page_never_splits_a_run_of_equal_revisions() -> None:
    # The limit falls inside the run of revision-2 tasks: it is dropped, not half-delivered, so the
    # cursor (1) cannot skip the rest of the run on the next pull.
    plan = plan_change_page([1, 2, 2, 2], since=0, limit=2)
    assert plan.deliver == 1
    assert plan.next_since == 1
    assert plan.has_more is True
    assert plan.complete_group is None


def test_a_single_continuing_run_larger_than_the_limit_is_delivered_whole() -> None:
    # Every fetched row is revision 3 and more remain: the group is returned in full (bounded by its
    # own size) so the cursor advances and the client makes progress.
    plan = plan_change_page([3, 3, 3], since=0, limit=2)
    assert plan.deliver == 0
    assert plan.next_since == 3
    assert plan.has_more is True
    assert plan.complete_group == 3


def test_a_limit_of_one_still_handles_a_tie() -> None:
    assert plan_change_page([1, 2], since=0, limit=1).deliver == 1
    whole_group = plan_change_page([1, 1], since=0, limit=1)
    assert whole_group.complete_group == 1
    assert whole_group.has_more is True


def test_a_cursor_beyond_every_revision_delivers_nothing() -> None:
    plan = plan_change_page([], since=7, limit=10)
    assert plan.next_since == 7
    assert plan.has_more is False


# --- paging covers the whole change set exactly once ---------------------------


def _page(revisions: list[int], since: int, limit: int) -> tuple[list[int], int, bool]:
    """Mimic the service's one-page algorithm over a plain revision list (no database)."""
    ordered = sorted(revision for revision in revisions if revision > since)
    window = ordered[: limit + 1]
    plan = plan_change_page(window, since=since, limit=limit)
    if plan.complete_group is not None:
        delivered = [revision for revision in ordered if revision == plan.complete_group]
        has_more = any(revision > plan.complete_group for revision in ordered)
        return delivered, plan.complete_group, has_more
    return window[: plan.deliver], plan.next_since, plan.has_more


def _drain(revisions: list[int], limit: int) -> list[int]:
    """Page through the change set until ``has_more`` is false, collecting every revision seen."""
    seen: list[int] = []
    since = 0
    for _ in range(len(revisions) + 3):
        page, since, has_more = _page(revisions, since, limit)
        assert page == sorted(page)  # each page is ordered by revision ascending
        seen.extend(page)
        if not has_more:
            # Once drained, pulling again at the new high-water mark returns nothing.
            assert _page(revisions, since, limit)[0] == []
            return seen
    raise AssertionError("paging did not converge")


@pytest.mark.parametrize("limit", [1, 2, 3, 4, 200])
def test_paging_covers_every_revision_once_with_no_gaps_or_duplicates(limit: int) -> None:
    revisions = [1, 1, 1, 2, 2, 3, 3, 3, 3, 5, 8, 8]
    seen = _drain(revisions, limit)
    assert sorted(seen) == sorted(revisions)
    assert len(seen) == len(revisions)  # no duplicates


def test_a_task_bumped_twice_between_pulls_appears_once_at_its_latest_revision() -> None:
    # First pull sees the task at revision 1; it is then bumped to 3 before the second pull.
    first, cursor, has_more = _page([1], 0, 10)
    assert first == [1]
    assert has_more is False
    second, cursor, has_more = _page([3], cursor, 10)
    assert second == [3]
    assert has_more is False


# --- API contract -------------------------------------------------------------


def _changes_operation() -> dict:
    return create_app().openapi()["paths"]["/api/tasks/changes"]["get"]


def test_the_changes_route_is_registered_as_a_read() -> None:
    paths = create_app().openapi()["paths"]
    assert set(paths["/api/tasks/changes"]) == {"get"}


def test_since_and_limit_are_optional_query_integers() -> None:
    parameters = {p["name"]: p for p in _changes_operation().get("parameters", [])}
    assert set(parameters) >= {"since", "limit"}
    for name in ("since", "limit"):
        assert parameters[name]["in"] == "query"
        assert parameters[name]["required"] is False


def test_the_response_schema_carries_the_cursor_and_the_rollup_fields() -> None:
    schemas = create_app().openapi()["components"]["schemas"]
    properties = schemas["TaskChangesOut"]["properties"]
    assert {"tasks", "since", "next_since", "has_more"} <= set(properties)
    # A change item is a task plus the tombstone marker.
    change = schemas["TaskChangeOut"]["properties"]
    assert "deleted_at" in change
    assert {"id", "revision", "title"} <= set(change)
