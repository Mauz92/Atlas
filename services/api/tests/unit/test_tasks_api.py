"""Tasks API contract and validation (M3-02): no database required."""

from __future__ import annotations

import uuid

import pytest
from pydantic import ValidationError

from atlas.api.schemas import TaskCreateRequest, TaskUpdateRequest
from atlas.main import create_app


def _paths() -> dict:
    return create_app().openapi()["paths"]


def test_task_routes_are_registered() -> None:
    paths = _paths()
    assert set(paths["/api/tasks"]) == {"get", "post"}
    assert set(paths["/api/tasks/{task_id}"]) == {"get", "patch", "delete"}


def test_mutations_accept_an_idempotency_key_header() -> None:
    paths = _paths()
    for method, path in (("post", "/api/tasks"), ("patch", "/api/tasks/{task_id}")):
        parameters = paths[path][method].get("parameters", [])
        headers = {p["name"] for p in parameters if p["in"] == "header"}
        assert "Idempotency-Key" in headers, (method, path)


def test_create_defaults_status_and_priority() -> None:
    request = TaskCreateRequest(title="Write the spec")
    assert request.status.value == "inbox"
    assert request.priority.value == "none"


def test_create_requires_a_non_empty_title() -> None:
    with pytest.raises(ValidationError):
        TaskCreateRequest(title="")


def test_create_rejects_an_unknown_priority() -> None:
    with pytest.raises(ValidationError):
        TaskCreateRequest(title="x", priority="someday")


def test_update_rejects_a_negative_base_revision() -> None:
    with pytest.raises(ValidationError):
        TaskUpdateRequest(base_revision=-1)


def test_a_known_time_zone_is_accepted() -> None:
    request = TaskCreateRequest(title="x", time_zone="Europe/Amsterdam")
    assert request.time_zone == "Europe/Amsterdam"


def test_an_unknown_time_zone_is_rejected() -> None:
    with pytest.raises(ValidationError):
        TaskCreateRequest(title="x", time_zone="Mars/Phobos")
    with pytest.raises(ValidationError):
        TaskUpdateRequest(time_zone="Mars/Phobos")


def test_a_task_can_be_created_without_a_project() -> None:
    """Membership is optional: a project is never required to create a task (M4-02)."""
    assert TaskCreateRequest(title="x").project_id is None


def test_update_distinguishes_an_omitted_project_from_an_explicit_null() -> None:
    """``PATCH`` clears membership with an explicit ``null`` and leaves it alone when omitted.

    The API sends only the fields the client actually set to the service
    (``model_dump(exclude_unset=True)``), so "move the task out of its project" and "do not touch
    the project" are distinct requests (M4-02).
    """
    assert "project_id" not in TaskUpdateRequest(title="x").model_dump(exclude_unset=True)
    assert TaskUpdateRequest(project_id=None).model_dump(exclude_unset=True) == {"project_id": None}

    project_id = uuid.uuid4()
    assert TaskUpdateRequest(project_id=project_id).model_dump(exclude_unset=True) == {
        "project_id": project_id
    }
