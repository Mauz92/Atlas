"""Derived project progress (M4-04): the pure formula and its edge cases — no database required.

The rule under test (``DATA_MODEL.md`` §2.3, ``DECISIONS.md`` ADR-0023): ``total`` counts a
project's live, non-``archived`` tasks; ``completed`` counts those whose status is ``completed``;
``percent`` is ``round(completed * 100 / total)`` with halves rounded up, and ``0`` when ``total``
is 0. Deleted tasks, ``archived`` tasks and tasks filed elsewhere never count.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from atlas.api.schemas import ProjectOut, ProjectProgressOut
from atlas.main import create_app
from atlas.projects import (
    ZERO_PROGRESS,
    ProgressTask,
    ProjectProgress,
    ProjectsService,
    progress_from_status_counts,
    project_progress,
)

# --- the pure formula ----------------------------------------------------------


def test_no_tasks_is_zero_and_never_complete() -> None:
    assert progress_from_status_counts({}) == ZERO_PROGRESS
    assert ProjectProgress(total=0, completed=0, percent=0) == ZERO_PROGRESS
    assert ZERO_PROGRESS.percent == 0  # a project with no work is not 100% done


def test_some_completed() -> None:
    progress = progress_from_status_counts({"inbox": 2, "completed": 1})
    assert progress == ProjectProgress(total=3, completed=1, percent=33)


def test_all_completed() -> None:
    assert progress_from_status_counts({"completed": 4}) == ProjectProgress(
        total=4, completed=4, percent=100
    )


def test_archived_tasks_are_excluded() -> None:
    progress = progress_from_status_counts({"archived": 5, "completed": 2, "inbox": 1})
    assert progress == ProjectProgress(total=3, completed=2, percent=67)


def test_a_project_of_only_archived_tasks_has_no_progress() -> None:
    assert progress_from_status_counts({"archived": 9}) == ZERO_PROGRESS


def test_percent_rounds_to_the_nearest_whole_and_halves_up() -> None:
    assert progress_from_status_counts({"completed": 1, "inbox": 1}).percent == 50  # 50.0
    assert progress_from_status_counts({"completed": 1, "inbox": 7}).percent == 13  # 12.5 -> 13
    assert progress_from_status_counts({"completed": 2, "inbox": 1}).percent == 67  # 66.67 -> 67
    assert progress_from_status_counts({"completed": 1, "inbox": 2}).percent == 33  # 33.33 -> 33


# --- membership, liveness and archived, applied to snapshots --------------------


def test_deleted_and_non_project_tasks_never_count() -> None:
    project, other = uuid.uuid4(), uuid.uuid4()
    tasks = [
        ProgressTask("completed", project),
        ProgressTask("inbox", project),
        ProgressTask("completed", project, deleted=True),  # tombstoned
        ProgressTask("completed", other),  # a different project
        ProgressTask("completed", None),  # filed under no project
    ]
    assert project_progress(project, tasks) == ProjectProgress(total=2, completed=1, percent=50)


def test_a_project_with_no_tasks_is_zero() -> None:
    assert project_progress(uuid.uuid4(), []) == ZERO_PROGRESS


# --- the service computes every project in one grouped query (no N+1) -----------


class _FakeResult:
    def __init__(self, rows: list[Any]) -> None:
        self._rows = rows

    def all(self) -> list[Any]:
        return self._rows


class _FakeSession:
    """Minimal ``AsyncSession`` stand-in that records the statements it is asked to run."""

    def __init__(self, rows: list[Any]) -> None:
        self._rows = rows
        self.statements: list[Any] = []

    async def execute(self, statement: Any) -> _FakeResult:
        self.statements.append(statement)
        return _FakeResult(self._rows)


async def test_progress_runs_one_grouped_query_for_many_projects() -> None:
    alpha, beta, empty = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    session = _FakeSession(
        [
            (alpha, "completed", 2),
            (alpha, "inbox", 1),
            (beta, "archived", 3),
        ]
    )
    service = ProjectsService(session, uuid.uuid4())

    progress = await service.progress([alpha, beta, empty])

    assert len(session.statements) == 1  # one round-trip for all three projects, not three
    assert progress[alpha] == ProjectProgress(total=3, completed=2, percent=67)
    assert progress[beta] == ZERO_PROGRESS  # only archived work
    assert empty not in progress  # no tasks at all


async def test_progress_of_no_projects_runs_no_query() -> None:
    session = _FakeSession([])
    service = ProjectsService(session, uuid.uuid4())

    assert await service.progress([]) == {}
    assert session.statements == []


# --- the API contract ----------------------------------------------------------


def test_project_response_carries_derived_progress() -> None:
    now = datetime.now(UTC)
    out = ProjectOut(
        id=uuid.uuid4(),
        name="Launch",
        description=None,
        status="active",
        start_date=None,
        target_date=None,
        progress=ProjectProgressOut(total=0, completed=0, percent=0),
        revision=1,
        created_at=now,
        updated_at=now,
    )
    assert out.progress == ProjectProgressOut(total=0, completed=0, percent=0)
    assert set(ProjectProgressOut.model_json_schema()["properties"]) == {
        "total",
        "completed",
        "percent",
    }


def test_openapi_exposes_progress_on_the_project_schema() -> None:
    schemas = create_app().openapi()["components"]["schemas"]
    assert "progress" in schemas["ProjectOut"]["properties"]
    assert "total" in schemas["ProjectProgressOut"]["properties"]
