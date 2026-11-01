"""Task list filters and text search (M3-08): pure logic and the API contract, no database.

Covers the normalisation rules in ``atlas/tasks/filters.py`` — status/priority parsing, the date
bounds, the search term and its ``LIKE`` escaping — and the ``GET /api/tasks`` query surface
(parameter names and bounds). The database behaviour is covered by
``tests/integration/test_tasks_filters.py``.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest

from atlas.main import create_app
from atlas.tasks import (
    DEFAULT_LIMIT,
    MAX_INSTANT_LENGTH,
    MAX_LIMIT,
    MAX_SEARCH_LENGTH,
    InvalidTaskFilterError,
    TaskFilters,
    build_filters,
    normalise_search,
    parse_instant,
    parse_priority,
    parse_statuses,
    search_pattern,
)
from atlas.tasks.filters import validate_range


def _query_parameters() -> dict[str, dict]:
    parameters = create_app().openapi()["paths"]["/api/tasks"]["get"].get("parameters", [])
    return {p["name"]: p for p in parameters if p["in"] == "query"}


# --- statuses -----------------------------------------------------------------


def test_status_is_accepted_repeated_or_comma_separated() -> None:
    assert parse_statuses(["inbox", "next"]) == ("inbox", "next")
    assert parse_statuses(["inbox,next"]) == ("inbox", "next")
    assert parse_statuses(["inbox, next ,archived"]) == ("inbox", "next", "archived")


def test_status_values_are_deduplicated_and_blanks_ignored() -> None:
    assert parse_statuses(["next", "next", "next,"]) == ("next",)
    assert parse_statuses([""]) == ()
    assert parse_statuses(None) == ()


def test_an_unknown_status_is_rejected() -> None:
    with pytest.raises(InvalidTaskFilterError):
        parse_statuses(["someday"])
    with pytest.raises(InvalidTaskFilterError):
        parse_statuses(["inbox,next,someday"])


def test_a_too_long_status_is_rejected() -> None:
    with pytest.raises(InvalidTaskFilterError):
        parse_statuses(["x" * 40])


def test_too_many_statuses_are_rejected() -> None:
    # 20 supplied values is the cap; a 21st (even a repeated, known value) is rejected.
    with pytest.raises(InvalidTaskFilterError):
        parse_statuses([",".join(["next"] * 21)])
    assert parse_statuses([",".join(["next"] * 20)]) == ("next",)


# --- priority -----------------------------------------------------------------


def test_priority_accepts_known_values_and_rejects_unknown_ones() -> None:
    assert parse_priority("urgent") == "urgent"
    assert parse_priority(" high ") == "high"
    assert parse_priority(None) is None
    assert parse_priority("  ") is None
    with pytest.raises(InvalidTaskFilterError):
        parse_priority("someday")


# --- date range ---------------------------------------------------------------


def test_a_date_only_bound_is_midnight_utc() -> None:
    assert parse_instant("2026-10-26", field="due_from") == datetime(2026, 10, 26, tzinfo=UTC)


def test_a_date_only_upper_bound_covers_the_whole_day() -> None:
    assert parse_instant("2026-10-26", field="due_to", end_of_day=True) == datetime(
        2026, 10, 26, 23, 59, 59, 999999, tzinfo=UTC
    )
    # The `_to` parameters use it; the `_from` parameters do not.
    assert build_filters(due_to="2026-10-26").due_to == datetime(
        2026, 10, 26, 23, 59, 59, 999999, tzinfo=UTC
    )
    assert build_filters(start_to="2026-10-26").start_to == datetime(
        2026, 10, 26, 23, 59, 59, 999999, tzinfo=UTC
    )
    assert build_filters(start_from="2026-10-26").start_from == datetime(2026, 10, 26, tzinfo=UTC)


def test_a_naive_instant_is_read_as_utc() -> None:
    assert parse_instant("2026-10-26T09:30:00", field="due_to") == datetime(
        2026, 10, 26, 9, 30, tzinfo=UTC
    )


def test_an_offset_is_converted_to_utc() -> None:
    # 09:30 in Amsterdam (UTC+1 in October) is 08:30 UTC.
    assert parse_instant("2026-10-26T09:30:00+01:00", field="start_from") == datetime(
        2026, 10, 26, 8, 30, tzinfo=UTC
    )
    assert parse_instant("2026-10-26T09:30:00Z", field="start_from") == datetime(
        2026, 10, 26, 9, 30, tzinfo=UTC
    )


def test_an_absent_or_blank_bound_means_no_bound() -> None:
    assert parse_instant(None, field="due_from") is None
    assert parse_instant("   ", field="due_from") is None


def test_a_malformed_bound_is_rejected() -> None:
    for value in ("yesterday", "2026-13-01", "26-10-2026", "x" * (MAX_INSTANT_LENGTH + 1)):
        with pytest.raises(InvalidTaskFilterError):
            parse_instant(value, field="due_from")


def test_an_inverted_range_is_rejected() -> None:
    earlier = datetime(2026, 10, 26, tzinfo=UTC)
    later = datetime(2026, 10, 27, tzinfo=UTC)
    validate_range(earlier, later, field="due")
    validate_range(later, later, field="due")
    validate_range(None, later, field="due")
    with pytest.raises(InvalidTaskFilterError):
        validate_range(later, earlier, field="due")


# --- text search --------------------------------------------------------------


def test_the_search_term_is_trimmed_and_bounded() -> None:
    assert normalise_search("  plan the week  ") == "plan the week"
    assert normalise_search("   ") is None
    assert normalise_search(None) is None
    with pytest.raises(InvalidTaskFilterError):
        normalise_search("x" * (MAX_SEARCH_LENGTH + 1))
    assert normalise_search("x" * MAX_SEARCH_LENGTH) is not None


def test_the_like_pattern_escapes_wildcards_and_the_escape_character() -> None:
    assert search_pattern("write") == "%write%"
    assert search_pattern("100%") == "%100\\%%"
    assert search_pattern("a_b") == "%a\\_b%"
    assert search_pattern("a\\b") == "%a\\\\b%"


# --- composition --------------------------------------------------------------


def test_no_parameters_produce_an_empty_filter_set() -> None:
    filters = build_filters()
    assert filters == TaskFilters()
    assert filters.is_empty


def test_blank_optional_parameters_are_ignored() -> None:
    assert build_filters(priority=" ", due_from=" ", q=" ", status=["  "]).is_empty


def test_filters_compose() -> None:
    project_id = uuid.uuid4()
    filters = build_filters(
        status=["next,in_progress"],
        priority="high",
        due_from="2026-10-26",
        due_to="2026-10-27T23:59:59Z",
        project_id=project_id,
        q=" spec ",
        start_from="2026-10-25",
    )
    assert not filters.is_empty
    assert filters.statuses == ("next", "in_progress")
    assert filters.priority == "high"  # exact enum values; case is not normalised
    assert filters.due_from == datetime(2026, 10, 26, tzinfo=UTC)
    assert filters.due_to == datetime(2026, 10, 27, 23, 59, 59, tzinfo=UTC)
    assert filters.start_from == datetime(2026, 10, 25, tzinfo=UTC)
    assert filters.project_id == project_id
    assert filters.search == "spec"


def test_an_inverted_due_range_is_rejected_by_build_filters() -> None:
    with pytest.raises(InvalidTaskFilterError):
        build_filters(due_from="2026-10-27", due_to="2026-10-26")


def test_an_inverted_start_range_is_rejected_by_build_filters() -> None:
    with pytest.raises(InvalidTaskFilterError):
        build_filters(start_from="2026-10-27", start_to="2026-10-26")


def test_every_individual_filter_makes_the_set_non_empty() -> None:
    assert not build_filters(status=["inbox"]).is_empty
    assert not build_filters(priority="none").is_empty
    assert not build_filters(due_from="2026-10-26").is_empty
    assert not build_filters(due_to="2026-10-26").is_empty
    assert not build_filters(start_from="2026-10-26").is_empty
    assert not build_filters(start_to="2026-10-26").is_empty
    assert not build_filters(project_id=uuid.uuid4()).is_empty
    assert not build_filters(q="x").is_empty


# --- API contract -------------------------------------------------------------


def test_list_tasks_exposes_the_filter_query_parameters() -> None:
    parameters = _query_parameters()
    assert {
        "view",
        "tz",
        "parent_task_id",
        "status",
        "priority",
        "due_from",
        "due_to",
        "start_from",
        "start_to",
        "project_id",
        "q",
        "limit",
    } <= set(parameters)


def test_the_search_parameter_is_length_bounded() -> None:
    q = _query_parameters()["q"]
    string_branch = next(b for b in q["schema"]["anyOf"] if b.get("type") == "string")
    assert string_branch["maxLength"] == MAX_SEARCH_LENGTH
    assert string_branch["minLength"] == 1


def test_the_limit_parameter_is_bounded_and_optional() -> None:
    limit = _query_parameters()["limit"]
    branch = next(b for b in limit["schema"]["anyOf"] if b.get("type") == "integer")
    assert branch["minimum"] == 1
    assert branch["maximum"] == MAX_LIMIT
    assert limit["required"] is False


def test_the_date_bounds_are_length_bounded() -> None:
    parameters = _query_parameters()
    for name in ("due_from", "due_to", "start_from", "start_to"):
        string_branch = next(
            b for b in parameters[name]["schema"]["anyOf"] if b.get("type") == "string"
        )
        assert string_branch["maxLength"] == MAX_INSTANT_LENGTH


def test_the_project_filter_is_a_uuid() -> None:
    project = _query_parameters()["project_id"]
    assert project["required"] is False
    assert any(b.get("format") == "uuid" for b in project["schema"]["anyOf"])


def test_the_status_parameter_is_an_array_of_strings() -> None:
    status = _query_parameters()["status"]
    assert status["required"] is False
    assert status["schema"]["anyOf"], status["schema"]


def test_the_default_limit_constant_is_documented() -> None:
    assert DEFAULT_LIMIT == 200
    assert MAX_LIMIT >= DEFAULT_LIMIT
