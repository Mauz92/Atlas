"""Tasks API contract and validation (M3-02): no database required."""

from __future__ import annotations

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
