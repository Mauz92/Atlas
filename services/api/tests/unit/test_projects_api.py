"""Projects API contract and validation (M4-01): no database required."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from atlas.api.schemas import ProjectCreateRequest, ProjectUpdateRequest
from atlas.main import create_app


def _paths() -> dict:
    return create_app().openapi()["paths"]


def test_project_routes_are_registered() -> None:
    paths = _paths()
    assert set(paths["/api/projects"]) == {"get", "post"}
    assert set(paths["/api/projects/{project_id}"]) == {"get", "patch", "delete"}


def test_mutations_accept_an_idempotency_key_header() -> None:
    paths = _paths()
    for method, path in (
        ("post", "/api/projects"),
        ("patch", "/api/projects/{project_id}"),
        ("delete", "/api/projects/{project_id}"),
    ):
        parameters = paths[path][method].get("parameters", [])
        headers = {p["name"] for p in parameters if p["in"] == "header"}
        assert "Idempotency-Key" in headers, (method, path)


def test_create_defaults_status_to_active() -> None:
    request = ProjectCreateRequest(name="Launch")
    assert request.status.value == "active"
    assert request.description is None
    assert request.start_date is None and request.target_date is None


def test_create_requires_a_non_empty_name() -> None:
    with pytest.raises(ValidationError):
        ProjectCreateRequest(name="")


def test_create_rejects_an_unknown_status() -> None:
    with pytest.raises(ValidationError):
        ProjectCreateRequest(name="x", status="someday")


def test_update_rejects_a_negative_base_revision() -> None:
    with pytest.raises(ValidationError):
        ProjectUpdateRequest(base_revision=-1)


def test_a_projects_tasks_are_exposed_as_a_read_only_sub_resource() -> None:
    """M4-02: ``GET /api/projects/{id}/tasks`` lists the project's tasks (read-only)."""
    paths = _paths()
    assert set(paths["/api/projects/{project_id}/tasks"]) == {"get"}


def test_the_project_task_listing_takes_a_project_id_and_a_bounded_limit() -> None:
    operation = _paths()["/api/projects/{project_id}/tasks"]["get"]
    names = {parameter["name"] for parameter in operation.get("parameters", [])}
    assert {"project_id", "limit"} <= names


def test_the_project_task_listing_returns_the_task_list_shape() -> None:
    """The listing reuses the task shape, so clients need no project-specific model."""
    response = _paths()["/api/projects/{project_id}/tasks"]["get"]["responses"]["200"]
    schema = response["content"]["application/json"]["schema"]
    assert schema.get("$ref", "").endswith("/TaskListOut")
