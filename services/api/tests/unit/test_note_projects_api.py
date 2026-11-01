"""Note↔project association API contract (M4-05): no database required."""

from __future__ import annotations

from atlas.main import create_app


def _paths() -> dict:
    return create_app().openapi()["paths"]


def _schemas() -> dict:
    return create_app().openapi()["components"]["schemas"]


def test_the_project_note_routes_are_registered() -> None:
    paths = _paths()
    assert set(paths["/api/projects/{project_id}/notes"]) == {"get"}
    assert set(paths["/api/projects/{project_id}/notes/{note_id}"]) == {"put", "delete"}
    assert set(paths["/api/notes/{note_id}/projects"]) == {"get"}


def test_the_project_notes_listing_returns_the_note_summary_shape() -> None:
    """The listing reuses the notes summary shape, so clients need no project-specific model."""
    response = _paths()["/api/projects/{project_id}/notes"]["get"]["responses"]["200"]
    schema = response["content"]["application/json"]["schema"]
    assert schema.get("$ref", "").endswith("/ProjectNotesOut")
    notes = _schemas()["ProjectNotesOut"]["properties"]["notes"]
    assert notes["type"] == "array"
    assert notes["items"]["$ref"].endswith("/NoteSummaryOut")


def test_the_note_projects_listing_reuses_the_project_list_shape() -> None:
    """A note's projects are returned as a full project list (with derived progress)."""
    response = _paths()["/api/notes/{note_id}/projects"]["get"]["responses"]["200"]
    schema = response["content"]["application/json"]["schema"]
    assert schema.get("$ref", "").endswith("/ProjectListOut")


def test_linking_is_a_put_and_unlinking_a_delete_on_the_same_path() -> None:
    operation = _paths()["/api/projects/{project_id}/notes/{note_id}"]
    assert set(operation) == {"put", "delete"}
    assert "204" in operation["put"]["responses"]
    assert "204" in operation["delete"]["responses"]
