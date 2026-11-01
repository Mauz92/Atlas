"""Inbox / Today / Upcoming view rules (M3-07): no database required.

Covers the pure classification rules (``atlas/tasks/views.py``), including the time-zone boundary
that decides whether a due instant is "today" for a caller, and the API contract (the ``view`` and
``tz`` query parameters and the derived ``due_state`` field).
"""

from __future__ import annotations

from datetime import UTC, datetime

from atlas.api.schemas import TaskOut
from atlas.main import create_app
from atlas.tasks import DueState, TaskView, due_state_for, effective_time_zone, matches_view

#: A fixed reference instant so the boundary cases are exactly reproducible.
NOW = datetime(2026, 10, 26, 12, 0, tzinfo=UTC)


def test_task_view_values() -> None:
    assert {view.value for view in TaskView} == {"inbox", "today", "upcoming"}


def test_effective_time_zone_prefers_the_tasks_own_zone() -> None:
    assert effective_time_zone("America/New_York", "Europe/Amsterdam") == "America/New_York"


def test_effective_time_zone_falls_back_to_the_caller_then_utc() -> None:
    assert effective_time_zone(None, "Europe/Amsterdam") == "Europe/Amsterdam"
    assert effective_time_zone(None, None) is None


def test_due_state_without_a_due_date_is_none() -> None:
    assert due_state_for(None, now=NOW) is DueState.NONE


def test_due_state_treats_an_equal_instant_as_due_today() -> None:
    assert due_state_for(NOW, now=NOW) is DueState.TODAY
    assert due_state_for(datetime(2026, 10, 26, 11, 59, tzinfo=UTC), now=NOW) is DueState.OVERDUE


def test_due_state_uses_the_callers_zone_for_a_zone_less_task() -> None:
    # 23:30 UTC is still the 26th in UTC but already 00:30 on the 27th in Europe/Amsterdam (UTC+1),
    # so the same instant is "today" for a UTC caller and "upcoming" for an Amsterdam caller.
    late = datetime(2026, 10, 26, 23, 30, tzinfo=UTC)
    assert due_state_for(late, now=NOW, caller_time_zone="UTC") is DueState.TODAY
    assert due_state_for(late, now=NOW, caller_time_zone="Europe/Amsterdam") is DueState.UPCOMING


def test_due_state_prefers_the_tasks_own_zone_over_the_callers() -> None:
    # The same instant is 19:30 on the 26th in New York, so the task's own zone makes it "today"
    # even though the caller is in Amsterdam, where it is already the 27th.
    late = datetime(2026, 10, 26, 23, 30, tzinfo=UTC)
    assert (
        due_state_for(
            late,
            now=NOW,
            task_time_zone="America/New_York",
            caller_time_zone="Europe/Amsterdam",
        )
        is DueState.TODAY
    )


def test_inbox_view_is_the_inbox_status() -> None:
    assert matches_view(TaskView.INBOX, status="inbox", state=DueState.NONE)
    assert not matches_view(TaskView.INBOX, status="next", state=DueState.NONE)


def test_today_view_is_overdue_or_due_today() -> None:
    assert matches_view(TaskView.TODAY, status="inbox", state=DueState.OVERDUE)
    assert matches_view(TaskView.TODAY, status="in_progress", state=DueState.TODAY)
    assert not matches_view(TaskView.TODAY, status="inbox", state=DueState.UPCOMING)
    assert not matches_view(TaskView.TODAY, status="inbox", state=DueState.NONE)


def test_upcoming_view_is_a_later_day() -> None:
    assert matches_view(TaskView.UPCOMING, status="next", state=DueState.UPCOMING)
    assert not matches_view(TaskView.UPCOMING, status="next", state=DueState.TODAY)


def test_today_and_upcoming_exclude_completed_and_archived() -> None:
    for status in ("completed", "archived"):
        assert not matches_view(TaskView.TODAY, status=status, state=DueState.OVERDUE)
        assert not matches_view(TaskView.UPCOMING, status=status, state=DueState.UPCOMING)


def _paths() -> dict:
    return create_app().openapi()["paths"]


def test_list_tasks_accepts_view_and_tz_query_parameters() -> None:
    parameters = _paths()["/api/tasks"]["get"].get("parameters", [])
    names = {p["name"] for p in parameters if p["in"] == "query"}
    assert {"view", "tz", "parent_task_id"} <= names


def test_tz_query_parameter_is_bounded() -> None:
    parameters = _paths()["/api/tasks"]["get"].get("parameters", [])
    tz = next(p for p in parameters if p["name"] == "tz")
    string_branch = next(b for b in tz["schema"]["anyOf"] if b.get("type") == "string")
    assert string_branch["maxLength"] == 64


def test_view_query_parameter_references_the_task_view_enum() -> None:
    parameters = _paths()["/api/tasks"]["get"].get("parameters", [])
    view = next(p for p in parameters if p["name"] == "view")
    refs = [b["$ref"] for b in view["schema"]["anyOf"] if "$ref" in b]
    assert refs == ["#/components/schemas/TaskView"]


def test_view_and_due_state_enums_are_exported() -> None:
    schemas = create_app().openapi()["components"]["schemas"]
    assert schemas["TaskView"]["enum"] == ["inbox", "today", "upcoming"]
    assert schemas["DueState"]["enum"] == ["none", "overdue", "today", "upcoming"]


def test_task_out_exposes_a_due_state() -> None:
    schemas = create_app().openapi()["components"]["schemas"]
    assert "due_state" in schemas["TaskOut"]["properties"]
    assert TaskOut.model_fields["due_state"].default is DueState.NONE
