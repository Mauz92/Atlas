"""Project export document shape and contract (M4-07): no database required.

Exercises the pure serialisation in :mod:`atlas.projects.export` — the versioned, open document
that is the export contract (ADR-0026) — and the OpenAPI surface of the export endpoints. The
document is built from plain duck-typed objects (``SimpleNamespace``), so these tests never touch
PostgreSQL.
"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime
from types import SimpleNamespace
from typing import Any

from atlas.api.schemas import ProjectsExportOut
from atlas.main import create_app
from atlas.projects import EXPORT_FORMAT, EXPORT_VERSION, ProjectExport, build_document
from atlas.projects.progress import ProjectProgress

_CREATED = datetime(2026, 10, 20, 9, 30, 0, tzinfo=UTC)
_UPDATED = datetime(2026, 10, 22, 15, 5, 1, tzinfo=UTC)


def _task(**overrides: Any) -> SimpleNamespace:
    values: dict[str, Any] = {
        "id": uuid.uuid4(),
        "title": "Ship the release",
        "description": "Cut the tag",
        "status": "in_progress",
        "priority": "high",
        "project_id": uuid.uuid4(),
        "parent_task_id": None,
        "start_at": datetime(2026, 11, 1, 8, 0, 0, tzinfo=UTC),
        "due_at": datetime(2026, 11, 2, 17, 0, 0, tzinfo=UTC),
        "time_zone": "Europe/Berlin",
        "duration_minutes": 30,
        "completed_at": None,
        "recurrence_rule": None,
        "recurrence_parent_id": None,
        "external_provider": None,
        "external_id": None,
        "revision": 3,
        "created_at": _CREATED,
        "updated_at": _UPDATED,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def _note(**overrides: Any) -> SimpleNamespace:
    values: dict[str, Any] = {
        "id": uuid.uuid4(),
        "path": "Plans/Launch.md",
        "title": "Launch",
        "revision": 2,
        "content_hash": "a" * 64,
        "size_bytes": 123,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def _project(**overrides: Any) -> SimpleNamespace:
    values: dict[str, Any] = {
        "id": uuid.uuid4(),
        "name": "Launch",
        "description": "Ship M4",
        "status": "active",
        "start_date": date(2026, 11, 1),
        "target_date": date(2026, 12, 15),
        "revision": 4,
        "created_at": _CREATED,
        "updated_at": _UPDATED,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def _document(*entries: ProjectExport, truncated: bool = False) -> dict[str, Any]:
    return build_document(entries, generated_at=_UPDATED, truncated=truncated)


def test_the_document_is_versioned_and_open() -> None:
    document = _document(ProjectExport(project=_project(), tasks=(), notes=()))

    assert document["format"] == "atlas.project-export"
    assert document["version"] == EXPORT_VERSION == 1
    assert list(document) == ["format", "version", "generated_at", "truncated", "projects"]
    # ISO-8601 UTC instants use a trailing Z.
    assert document["generated_at"] == "2026-10-22T15:05:01Z"
    assert document["truncated"] is False


def test_the_document_is_empty_but_well_formed_with_no_projects() -> None:
    document = build_document([], generated_at=_UPDATED, truncated=True)

    assert document["projects"] == []
    assert document["truncated"] is True
    assert document["format"] == EXPORT_FORMAT
    assert document["version"] == EXPORT_VERSION


def test_a_project_document_carries_the_documented_fields_and_progress() -> None:
    project = _project()
    entry = ProjectExport(
        project=project,
        tasks=(),
        notes=(),
        progress=ProjectProgress(total=4, completed=1, percent=25),
    )

    out = _document(entry)["projects"][0]

    assert out["id"] == str(project.id)
    assert out["name"] == "Launch"
    assert out["description"] == "Ship M4"
    assert out["status"] == "active"
    assert out["start_date"] == "2026-11-01"  # a calendar day, not an instant
    assert out["target_date"] == "2026-12-15"
    assert out["revision"] == 4
    assert out["created_at"] == "2026-10-20T09:30:00Z"
    assert out["updated_at"] == "2026-10-22T15:05:01Z"
    assert out["progress"] == {"total": 4, "completed": 1, "percent": 25}
    assert out["tasks"] == [] and out["notes"] == []


def test_a_project_with_no_tasks_reports_zero_progress() -> None:
    out = _document(ProjectExport(project=_project(), tasks=(), notes=()))["projects"][0]
    assert out["progress"] == {"total": 0, "completed": 0, "percent": 0}


def test_a_task_document_carries_the_documented_fields() -> None:
    task = _task()
    entry = ProjectExport(project=_project(), tasks=(task,), notes=())

    out = _document(entry)["projects"][0]["tasks"][0]

    assert set(out) == {
        "id",
        "title",
        "description",
        "status",
        "priority",
        "project_id",
        "parent_task_id",
        "start_at",
        "due_at",
        "time_zone",
        "duration_minutes",
        "completed_at",
        "recurrence_rule",
        "recurrence_parent_id",
        "external_provider",
        "external_id",
        "revision",
        "created_at",
        "updated_at",
    }
    assert out["id"] == str(task.id)
    assert out["project_id"] == str(task.project_id)
    assert out["start_at"] == "2026-11-01T08:00:00Z"
    assert out["due_at"] == "2026-11-02T17:00:00Z"
    assert out["time_zone"] == "Europe/Berlin"
    assert out["revision"] == 3
    assert out["created_at"] == "2026-10-20T09:30:00Z"
    assert out["updated_at"] == "2026-10-22T15:05:01Z"


def test_absent_optional_values_stay_null() -> None:
    task = _task(
        description=None,
        project_id=None,
        parent_task_id=None,
        start_at=None,
        due_at=None,
        time_zone=None,
        duration_minutes=None,
        completed_at=None,
        recurrence_rule=None,
        recurrence_parent_id=None,
        external_provider=None,
        external_id=None,
    )
    project = _project(description=None, start_date=None, target_date=None)
    entry = ProjectExport(project=project, tasks=(task,), notes=())

    project_out = _document(entry)["projects"][0]

    assert project_out["description"] is None
    assert project_out["start_date"] is None and project_out["target_date"] is None
    task_out = project_out["tasks"][0]
    assert task_out["description"] is None
    assert task_out["project_id"] is None
    assert task_out["start_at"] is None and task_out["due_at"] is None
    assert task_out["completed_at"] is None
    assert task_out["recurrence_rule"] is None


def test_a_linked_note_is_exported_with_the_summary_shape() -> None:
    note = _note()
    entry = ProjectExport(project=_project(), tasks=(), notes=(note,))

    out = _document(entry)["projects"][0]["notes"][0]

    assert out == {
        "id": str(note.id),
        "path": "Plans/Launch.md",
        "title": "Launch",
        "revision": 2,
        "content_hash": "a" * 64,
        "size_bytes": 123,
    }


def test_tasks_and_notes_keep_the_order_they_are_given() -> None:
    first, second = _task(title="A"), _task(title="B")
    note_a, note_b = _note(path="a.md"), _note(path="b.md")
    entry = ProjectExport(project=_project(), tasks=(first, second), notes=(note_a, note_b))

    out = _document(entry)["projects"][0]

    assert [task["title"] for task in out["tasks"]] == ["A", "B"]
    assert [note["path"] for note in out["notes"]] == ["a.md", "b.md"]


def test_the_built_document_satisfies_the_declared_response_schema() -> None:
    """The wire shape and the OpenAPI response model cannot drift apart."""
    entry = ProjectExport(
        project=_project(),
        tasks=(_task(),),
        notes=(_note(),),
        progress=ProjectProgress(total=1, completed=0, percent=0),
    )

    document = _document(entry, truncated=True)

    parsed = ProjectsExportOut.model_validate(document)
    assert parsed.format == EXPORT_FORMAT
    assert parsed.version == EXPORT_VERSION
    assert parsed.truncated is True
    assert [project.id for project in parsed.projects] == [entry.project.id]
    assert [task.id for task in parsed.projects[0].tasks] == [entry.tasks[0].id]
    assert [note.id for note in parsed.projects[0].notes] == [entry.notes[0].id]


# --- OpenAPI surface -----------------------------------------------------------


def _paths() -> dict:
    return create_app().openapi()["paths"]


def test_the_export_routes_are_registered_read_only() -> None:
    paths = _paths()
    assert set(paths["/api/projects/export"]) == {"get"}
    assert set(paths["/api/projects/{project_id}/export"]) == {"get"}


def test_the_all_projects_export_takes_a_bounded_limit() -> None:
    operation = _paths()["/api/projects/export"]["get"]
    parameters = {parameter["name"]: parameter for parameter in operation.get("parameters", [])}
    assert "limit" in parameters
    # An optional int query parameter is an ``anyOf`` of the bounded integer and null.
    integer_schema = next(
        branch
        for branch in parameters["limit"]["schema"]["anyOf"]
        if branch.get("type") == "integer"
    )
    assert integer_schema["minimum"] == 1 and integer_schema["maximum"] == 500


def test_both_exports_return_the_versioned_document_shape() -> None:
    paths = _paths()
    for path in ("/api/projects/export", "/api/projects/{project_id}/export"):
        response = paths[path]["get"]["responses"]["200"]
        schema = response["content"]["application/json"]["schema"]
        assert schema.get("$ref", "").endswith("/ProjectsExportOut")
