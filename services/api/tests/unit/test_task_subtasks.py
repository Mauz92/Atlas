"""Subtask (parent/child) rules and rollup (M3-06): pure logic, no database."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest

from atlas.main import create_app
from atlas.models import Task, TaskStatus
from atlas.tasks import TasksService
from atlas.tasks.subtasks import (
    ParentRef,
    SubtaskError,
    ensure_parent_is_usable,
    rollup_from_statuses,
    subtask_project_id,
    validate_parent,
)


def _id() -> uuid.UUID:
    return uuid.uuid4()


# --- validate_parent (self / cycle) ----------------------------------------


def test_a_task_can_be_a_subtask_of_an_unrelated_task() -> None:
    validate_parent(task_id=_id(), parent=ParentRef(id=_id(), project_id=None))


def test_a_new_task_has_no_ancestors_to_cycle_through() -> None:
    # task_id is None on create: a brand-new task cannot already be anyone's ancestor.
    parent = ParentRef(id=_id(), project_id=None, ancestor_ids=(_id(),))
    validate_parent(task_id=None, parent=parent)


def test_a_task_cannot_be_its_own_parent() -> None:
    task_id = _id()
    with pytest.raises(SubtaskError, match="its own parent"):
        validate_parent(task_id=task_id, parent=ParentRef(id=task_id, project_id=None))


def test_a_direct_cycle_is_rejected() -> None:
    # A is the parent of B; making B the parent of A would close a cycle.
    a = _id()
    b = _id()
    with pytest.raises(SubtaskError, match="its own ancestor"):
        validate_parent(task_id=a, parent=ParentRef(id=b, project_id=None, ancestor_ids=(a,)))


def test_a_cycle_at_depth_greater_than_one_is_rejected() -> None:
    # A -> B -> C: making A a child of C would close a cycle two levels down.
    a, b, c = _id(), _id(), _id()
    with pytest.raises(SubtaskError, match="its own ancestor"):
        validate_parent(task_id=a, parent=ParentRef(id=c, project_id=None, ancestor_ids=(b, a)))


def test_an_unrelated_ancestor_chain_is_allowed() -> None:
    task_id = _id()
    validate_parent(
        task_id=task_id, parent=ParentRef(id=_id(), project_id=None, ancestor_ids=(_id(), _id()))
    )


# --- ensure_parent_is_usable (missing / cross-user / deleted) --------------


def test_a_present_owned_parent_is_usable() -> None:
    ensure_parent_is_usable(found=True, same_user=True, deleted=False)


@pytest.mark.parametrize(
    ("found", "same_user", "deleted"),
    [
        (False, False, False),  # missing
        (True, False, False),  # another user's task
        (True, True, True),  # soft-deleted
    ],
)
def test_an_unusable_parent_is_rejected(found: bool, same_user: bool, deleted: bool) -> None:
    with pytest.raises(SubtaskError) as excinfo:
        ensure_parent_is_usable(found=found, same_user=same_user, deleted=deleted)
    # A single message for every case: no way to probe another user's task ids.
    assert str(excinfo.value) == "parent task does not exist"


# --- Project inheritance ----------------------------------------------------


def test_a_subtask_inherits_the_parents_project_when_none_is_sent() -> None:
    project = _id()
    assert subtask_project_id(None, project, provided=False) == project
    assert subtask_project_id(None, None, provided=False) is None


def test_a_provided_project_matching_the_parent_is_accepted() -> None:
    project = _id()
    assert subtask_project_id(project, project, provided=True) == project
    assert subtask_project_id(None, None, provided=True) is None


def test_a_conflicting_project_is_rejected() -> None:
    with pytest.raises(SubtaskError, match="share its parent's project"):
        subtask_project_id(_id(), _id(), provided=True)
    # A project-less parent cannot be given a project-ful subtask.
    with pytest.raises(SubtaskError, match="share its parent's project"):
        subtask_project_id(_id(), None, provided=True)


# --- Completion rollup ------------------------------------------------------


def test_the_rollup_of_a_task_without_subtasks_is_empty() -> None:
    rollup = rollup_from_statuses([])
    assert (rollup.total, rollup.done) == (0, 0)
    assert rollup.all_done is False


def test_the_rollup_counts_completed_subtasks() -> None:
    rollup = rollup_from_statuses(
        [TaskStatus.COMPLETED.value, TaskStatus.INBOX.value, TaskStatus.NEXT.value]
    )
    assert (rollup.total, rollup.done) == (3, 1)
    assert rollup.all_done is False


def test_the_rollup_is_all_done_only_when_every_subtask_is_completed() -> None:
    rollup = rollup_from_statuses([TaskStatus.COMPLETED.value, TaskStatus.COMPLETED.value])
    assert (rollup.total, rollup.done) == (2, 2)
    assert rollup.all_done is True


def test_archived_subtasks_count_towards_total_but_not_done() -> None:
    rollup = rollup_from_statuses([TaskStatus.COMPLETED.value, TaskStatus.ARCHIVED.value])
    assert (rollup.total, rollup.done) == (2, 1)
    assert rollup.all_done is False


# --- Recurrence interaction (pure) -----------------------------------------


def test_a_generated_occurrence_is_top_level_and_copies_no_subtask() -> None:
    completed = Task(
        user_id=_id(),
        title="Stand-up",
        status=TaskStatus.COMPLETED.value,
        recurrence_rule="FREQ=DAILY;COUNT=3",
    )
    head_id = _id()
    occurrence = TasksService._build_occurrence(
        completed,
        "FREQ=DAILY;COUNT=3",
        head_id,
        "due_at",
        datetime(2026, 1, 2, 9, tzinfo=UTC),
        datetime(2026, 1, 3, 9, tzinfo=UTC),
    )
    # A fresh top-level task: it never points at the completed occurrence's parent.
    assert occurrence.parent_task_id is None
    assert occurrence.recurrence_parent_id == head_id
    assert occurrence.due_at == datetime(2026, 1, 3, 9, tzinfo=UTC)


# --- API contract -----------------------------------------------------------


def test_list_tasks_accepts_a_parent_task_id_query_parameter() -> None:
    parameters = create_app().openapi()["paths"]["/api/tasks"]["get"].get("parameters", [])
    assert {p["name"]: p["in"] for p in parameters}.get("parent_task_id") == "query"


def test_task_out_exposes_the_subtask_rollup() -> None:
    properties = create_app().openapi()["components"]["schemas"]["TaskOut"]["properties"]
    assert {"subtasks_total", "subtasks_done"} <= set(properties)
