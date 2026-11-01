"""Project export over HTTP against a real PostgreSQL (M4-07).

Covers the M4-07 acceptance criteria: a project (and all projects) export as one versioned, open
JSON document; the export is faithful (documented fields, stable ids, ISO-8601 UTC instants, the
derived ``progress``); note↔project links are included; soft-deleted rows are excluded; the export
is bounded and reports truncation; and it is strictly user-scoped (another user's data never
appears). Requires a database (``client``/``notes_client`` pull in ``_db``).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import text

from atlas.db import session_scope
from atlas.models import NoteIndex, NoteProject, Project, ProjectStatus, Task, User
from atlas.projects import ProjectsService
from tests.conftest import create_user_via_setup, csrf_headers

if TYPE_CHECKING:
    from httpx import AsyncClient


async def _auth(client: AsyncClient) -> dict[str, str]:
    await create_user_via_setup(client)
    return csrf_headers(client)


async def _project(
    client: AsyncClient, headers: dict[str, str], name: str = "Project", **extra: Any
) -> dict:
    response = await client.post("/api/projects", json={"name": name, **extra}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


async def _task(
    client: AsyncClient, headers: dict[str, str], title: str = "Task", **payload: Any
) -> dict:
    response = await client.post("/api/tasks", json={"title": title, **payload}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


async def _note(client: AsyncClient, headers: dict[str, str], path: str = "Note.md") -> dict:
    response = await client.post(
        "/api/notes", json={"path": path, "content": "# Note\n"}, headers=headers
    )
    assert response.status_code == 201, response.text
    return response.json()


async def _export_all(client: AsyncClient, **params: object) -> dict:
    response = await client.get("/api/projects/export", params=params)
    assert response.status_code == 200, response.text
    return response.json()


async def _export_one(client: AsyncClient, project_id: str) -> dict:
    response = await client.get(f"/api/projects/{project_id}/export")
    assert response.status_code == 200, response.text
    return response.json()


def _parse(instant: str) -> datetime:
    """Parse an exported ISO-8601 instant and assert it is UTC."""
    parsed = datetime.fromisoformat(instant.replace("Z", "+00:00"))
    assert parsed.tzinfo is not None
    assert parsed.utcoffset() == UTC.utcoffset(parsed)
    return parsed


def _project_by_id(document: dict, project_id: str) -> dict:
    matches = [project for project in document["projects"] if project["id"] == project_id]
    assert len(matches) == 1, document
    return matches[0]


# --- a project with tasks ------------------------------------------------------


async def test_a_project_with_its_tasks_exports_in_the_open_format(client: AsyncClient) -> None:
    headers = await _auth(client)
    project = await _project(
        client,
        headers,
        "Launch",
        description="Ship M4",
        start_date="2026-11-01",
        target_date="2026-12-15",
    )
    done = await _task(client, headers, "Done", project_id=project["id"], status="completed")
    open_task = await _task(
        client,
        headers,
        "Open",
        project_id=project["id"],
        priority="high",
        due_at="2026-11-02T17:00:00Z",
        time_zone="Europe/Berlin",
    )

    document = await _export_one(client, project["id"])

    assert document["format"] == "atlas.project-export"
    assert document["version"] == 1
    assert document["truncated"] is False
    assert _parse(document["generated_at"])
    assert len(document["projects"]) == 1

    exported = document["projects"][0]
    assert exported["id"] == project["id"]
    assert exported["name"] == "Launch"
    assert exported["description"] == "Ship M4"
    assert exported["status"] == "active"
    assert exported["start_date"] == "2026-11-01"
    assert exported["target_date"] == "2026-12-15"
    assert exported["revision"] == project["revision"]
    assert _parse(exported["created_at"]) and _parse(exported["updated_at"])
    assert exported["progress"] == {"total": 2, "completed": 1, "percent": 50}
    assert exported["notes"] == []

    by_id = {task["id"]: task for task in exported["tasks"]}
    assert set(by_id) == {done["id"], open_task["id"]}
    assert by_id[open_task["id"]]["project_id"] == project["id"]
    assert by_id[open_task["id"]]["priority"] == "high"
    assert by_id[open_task["id"]]["time_zone"] == "Europe/Berlin"
    assert by_id[open_task["id"]]["due_at"] == _parse(open_task["due_at"]).isoformat().replace(
        "+00:00", "Z"
    )
    assert by_id[done["id"]]["completed_at"] is not None


async def test_the_exported_instants_are_iso_8601_utc(client: AsyncClient) -> None:
    headers = await _auth(client)
    project = await _project(client, headers, "Launch")
    await _task(client, headers, "Task", project_id=project["id"], due_at="2026-11-02T17:00:00Z")

    exported = (await _export_one(client, project["id"]))["projects"][0]

    assert exported["created_at"].endswith("Z")
    assert exported["updated_at"].endswith("Z")
    assert exported["tasks"][0]["due_at"].endswith("Z")
    assert _parse(exported["created_at"]).tzinfo is not None


# --- all projects --------------------------------------------------------------


async def test_all_projects_export_groups_tasks_by_project_and_skips_unfiled_work(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    alpha = await _project(client, headers, "Alpha")
    beta = await _project(client, headers, "Beta")
    await _task(client, headers, "A one", project_id=alpha["id"])
    await _task(client, headers, "A two", project_id=alpha["id"], status="completed")
    await _task(client, headers, "B one", project_id=beta["id"])
    await _task(client, headers, "Unfiled")  # no project → not part of any project export

    document = await _export_all(client)

    assert {project["id"] for project in document["projects"]} == {alpha["id"], beta["id"]}
    assert [task["title"] for task in _project_by_id(document, alpha["id"])["tasks"]] == [
        "A one",
        "A two",
    ]
    assert [task["title"] for task in _project_by_id(document, beta["id"])["tasks"]] == ["B one"]
    assert _project_by_id(document, alpha["id"])["progress"] == {
        "total": 2,
        "completed": 1,
        "percent": 50,
    }


async def test_an_empty_export_is_well_formed(client: AsyncClient) -> None:
    await _auth(client)

    document = await _export_all(client)

    assert document["projects"] == []
    assert document["truncated"] is False
    assert document["format"] == "atlas.project-export" and document["version"] == 1
    assert _parse(document["generated_at"])


# --- faithfulness --------------------------------------------------------------


async def test_the_export_matches_the_project_and_task_endpoints(client: AsyncClient) -> None:
    headers = await _auth(client)
    project = await _project(client, headers, "Launch", start_date="2026-11-01")
    task = await _task(
        client,
        headers,
        "Fidelity",
        project_id=project["id"],
        priority="urgent",
        due_at="2026-11-05T09:00:00Z",
    )

    exported_project = (await _export_one(client, project["id"]))["projects"][0]
    live_project = (await client.get(f"/api/projects/{project['id']}")).json()
    live_task = (await client.get(f"/api/tasks/{task['id']}")).json()

    for field in ("id", "name", "status", "start_date", "target_date", "revision", "progress"):
        assert exported_project[field] == live_project[field], field

    exported_task = next(t for t in exported_project["tasks"] if t["id"] == task["id"])
    for field in ("id", "title", "status", "priority", "project_id", "time_zone", "revision"):
        assert exported_task[field] == live_task[field], field
    assert _parse(exported_task["due_at"]) == _parse(live_task["due_at"])
    # The export carries stored fields only — no request-relative derivation.
    assert {"due_state", "subtasks_total", "subtasks_done", "deleted_at"}.isdisjoint(exported_task)


async def test_archived_tasks_are_exported_but_not_counted_in_progress(client: AsyncClient) -> None:
    headers = await _auth(client)
    project = await _project(client, headers, "Launch")
    await _task(client, headers, "Open", project_id=project["id"])
    await _task(client, headers, "Shelved", project_id=project["id"], status="archived")

    exported = (await _export_one(client, project["id"]))["projects"][0]

    assert {task["title"] for task in exported["tasks"]} == {"Open", "Shelved"}
    # The derived progress follows the documented formula and excludes archived work (ADR-0023).
    assert exported["progress"] == {"total": 1, "completed": 0, "percent": 0}


async def test_soft_deleted_rows_are_excluded(client: AsyncClient) -> None:
    headers = await _auth(client)
    kept_project = await _project(client, headers, "Kept")
    doomed_project = await _project(client, headers, "Doomed")
    kept = await _task(client, headers, "Kept task", project_id=kept_project["id"])
    gone = await _task(client, headers, "Gone task", project_id=kept_project["id"])

    assert (await client.delete(f"/api/tasks/{gone['id']}", headers=headers)).status_code == 204
    assert (
        await client.delete(f"/api/projects/{doomed_project['id']}", headers=headers)
    ).status_code == 204

    document = await _export_all(client)

    assert {project["id"] for project in document["projects"]} == {kept_project["id"]}
    assert [task["id"] for task in document["projects"][0]["tasks"]] == [kept["id"]]


# --- note↔project links --------------------------------------------------------


async def test_linked_notes_are_included_and_follow_a_rename(notes_client: AsyncClient) -> None:
    headers = await _auth(notes_client)
    project = await _project(notes_client, headers, "Launch")
    note = await _note(notes_client, headers, "Plans/Launch.md")
    unlinked = await _note(notes_client, headers, "Other.md")
    assert (
        await notes_client.put(f"/api/projects/{project['id']}/notes/{note['id']}", headers=headers)
    ).status_code == 204

    exported = (await _export_one(notes_client, project["id"]))["projects"][0]
    assert [item["id"] for item in exported["notes"]] == [note["id"]]
    assert exported["notes"][0]["path"] == "Plans/Launch.md"
    assert unlinked["id"] not in {item["id"] for item in exported["notes"]}

    # The link references the note's stable id, so a rename is reflected as a new path (M4-05).
    renamed = await notes_client.post(
        f"/api/notes/{note['id']}/move", json={"path": "Plans/Renamed.md"}, headers=headers
    )
    assert renamed.status_code == 200, renamed.text

    exported_after = (await _export_one(notes_client, project["id"]))["projects"][0]
    assert [item["id"] for item in exported_after["notes"]] == [note["id"]]
    assert exported_after["notes"][0]["path"] == "Plans/Renamed.md"


# --- scale: the bound -----------------------------------------------------------


async def test_the_project_export_is_bounded_and_reports_truncation(client: AsyncClient) -> None:
    headers = await _auth(client)
    for name in ("One", "Two", "Three"):
        await _project(client, headers, name)

    capped = await _export_all(client, limit=2)
    assert len(capped["projects"]) == 2
    assert capped["truncated"] is True

    complete = await _export_all(client, limit=3)
    assert {project["name"] for project in complete["projects"]} == {"One", "Two", "Three"}
    assert complete["truncated"] is False

    # The default bound (200) covers all three projects.
    assert (await _export_all(client))["truncated"] is False


async def test_the_export_limit_is_validated_without_side_effects(client: AsyncClient) -> None:
    headers = await _auth(client)
    project = await _project(client, headers, "Launch")
    before = await _export_all(client)

    assert (await client.get("/api/projects/export", params={"limit": 0})).status_code == 422
    assert (await client.get("/api/projects/export", params={"limit": 501})).status_code == 422

    after = await _export_all(client)
    assert after["projects"] == before["projects"]
    assert after["projects"][0]["id"] == project["id"]


# --- user scoping --------------------------------------------------------------


async def _seed_foreign() -> str:
    """Another user's project (with a task and a linked note); returns the project id.

    Inserted directly so the account's data exists only to prove it never leaks into the
    authenticated caller's export.
    """
    async with session_scope() as session:
        other = User(
            id=uuid.uuid4(),
            email=f"{uuid.uuid4()}@example.com",
            display_name="Other",
            password_hash="not-used",
        )
        session.add(other)
        await session.flush()
        project = Project(
            id=uuid.uuid4(),
            user_id=other.id,
            name="Theirs",
            status=ProjectStatus.ACTIVE.value,
        )
        note = NoteIndex(
            id=uuid.uuid4(),
            user_id=other.id,
            path="Theirs.md",
            title="Theirs",
            content_hash="0" * 64,
            revision=1,
            size_bytes=0,
        )
        session.add_all([project, note])
        await session.flush()
        session.add(Task(user_id=other.id, title="Their task", project_id=project.id))
        session.add(NoteProject(note_id=note.id, project_id=project.id))
        await session.flush()
        return str(project.id)


async def test_the_export_is_strictly_user_scoped(client: AsyncClient) -> None:
    headers = await _auth(client)
    mine = await _project(client, headers, "Mine")
    my_task = await _task(client, headers, "Mine task", project_id=mine["id"])
    foreign_project_id = await _seed_foreign()

    document = await _export_all(client)

    # Only the caller's project is present, and the foreign project id does not leak anywhere.
    assert [project["id"] for project in document["projects"]] == [mine["id"]]
    assert [task["id"] for task in document["projects"][0]["tasks"]] == [my_task["id"]]
    assert foreign_project_id != mine["id"]


async def test_a_single_project_export_reports_unknown_and_foreign_as_missing(
    client: AsyncClient,
) -> None:
    await _auth(client)
    foreign_project_id = await _seed_foreign()

    assert (await client.get(f"/api/projects/{uuid.uuid4()}/export")).status_code == 404
    assert (await client.get(f"/api/projects/{foreign_project_id}/export")).status_code == 404


async def test_a_tombstoned_project_cannot_be_exported(client: AsyncClient) -> None:
    headers = await _auth(client)
    project = await _project(client, headers, "Doomed")
    assert (
        await client.delete(f"/api/projects/{project['id']}", headers=headers)
    ).status_code == 204

    assert (await client.get(f"/api/projects/{project['id']}/export")).status_code == 404


async def test_the_export_reads_one_repeatable_read_snapshot(client: AsyncClient) -> None:
    """The whole export runs in one REPEATABLE READ transaction, so it cannot tear (M4-07)."""
    await _auth(client)
    user_id = uuid.UUID((await client.get("/api/auth/me")).json()["id"])

    async with session_scope() as session:
        service = ProjectsService(session, user_id)
        entries, truncated = await service.export()
        # Still inside the transaction the export opened: PostgreSQL reports the isolation.
        isolation = await session.scalar(text("SHOW transaction_isolation"))

    assert isolation == "repeatable read"
    assert entries == [] and truncated is False


async def test_the_exports_require_authentication(client: AsyncClient) -> None:
    assert (await client.get("/api/projects/export")).status_code == 401
    assert (await client.get(f"/api/projects/{uuid.uuid4()}/export")).status_code == 401
