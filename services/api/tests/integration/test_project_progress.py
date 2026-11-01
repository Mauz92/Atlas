"""Derived project progress over HTTP against a real PostgreSQL (M4-04).

Progress is derived, not stored: every project response carries a ``progress`` object computed
from the project's tasks (``DECISIONS.md`` ADR-0023). These tests create tasks in every relevant
state and assert the value reported by ``GET /api/projects``, ``GET /api/projects/{id}`` and the
project-create response, including the exclusions (archived tasks, tombstoned tasks and tasks
filed elsewhere). They require a database (``client`` pulls in ``_db``).
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from atlas.db import session_scope
from atlas.models import Task, User
from tests.conftest import create_user_via_setup, csrf_headers

if TYPE_CHECKING:
    from httpx import AsyncClient

ZERO = {"total": 0, "completed": 0, "percent": 0}


async def _auth(client: AsyncClient) -> dict[str, str]:
    await create_user_via_setup(client)
    return csrf_headers(client)


async def _project(client: AsyncClient, headers: dict[str, str], name: str = "Project") -> dict:
    response = await client.post("/api/projects", json={"name": name}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


async def _task(
    client: AsyncClient, headers: dict[str, str], title: str = "Task", **payload: object
) -> dict:
    response = await client.post("/api/tasks", json={"title": title, **payload}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


async def _progress(client: AsyncClient, project_id: str) -> dict:
    response = await client.get(f"/api/projects/{project_id}")
    assert response.status_code == 200, response.text
    return response.json()["progress"]


async def test_a_new_project_reports_zero_progress(client: AsyncClient) -> None:
    headers = await _auth(client)
    project = await _project(client, headers, "Fresh")
    assert project["progress"] == ZERO
    assert await _progress(client, project["id"]) == ZERO


async def test_progress_counts_completed_tasks_of_the_project(client: AsyncClient) -> None:
    headers = await _auth(client)
    project = await _project(client, headers, "Launch")
    await _task(client, headers, "Done", project_id=project["id"], status="completed")
    await _task(client, headers, "Open", project_id=project["id"])
    await _task(client, headers, "Also open", project_id=project["id"])

    assert await _progress(client, project["id"]) == {"total": 3, "completed": 1, "percent": 33}


async def test_all_completed_is_one_hundred_percent(client: AsyncClient) -> None:
    headers = await _auth(client)
    project = await _project(client, headers, "Launch")
    await _task(client, headers, "One", project_id=project["id"], status="completed")
    await _task(client, headers, "Two", project_id=project["id"], status="completed")

    assert await _progress(client, project["id"]) == {"total": 2, "completed": 2, "percent": 100}


async def test_archived_deleted_and_unfiled_tasks_are_excluded(client: AsyncClient) -> None:
    headers = await _auth(client)
    project = await _project(client, headers, "Launch")
    await _task(client, headers, "Done", project_id=project["id"], status="completed")
    await _task(client, headers, "Open", project_id=project["id"])
    await _task(client, headers, "Shelved", project_id=project["id"], status="archived")
    gone = await _task(client, headers, "Gone", project_id=project["id"])
    await _task(client, headers, "Unfiled", status="completed")  # no project at all

    assert (await client.delete(f"/api/tasks/{gone['id']}", headers=headers)).status_code == 204

    # Only the live, non-archived, still-filed tasks count: "Done" and "Open".
    assert await _progress(client, project["id"]) == {"total": 2, "completed": 1, "percent": 50}


async def test_progress_follows_task_changes(client: AsyncClient) -> None:
    headers = await _auth(client)
    project = await _project(client, headers, "Launch")
    task = await _task(client, headers, "Only", project_id=project["id"])
    assert await _progress(client, project["id"]) == {"total": 1, "completed": 0, "percent": 0}

    completed = await client.patch(
        f"/api/tasks/{task['id']}", json={"status": "completed"}, headers=headers
    )
    assert completed.status_code == 200, completed.text
    assert await _progress(client, project["id"]) == {"total": 1, "completed": 1, "percent": 100}


async def test_archiving_a_completed_task_stops_it_counting(client: AsyncClient) -> None:
    headers = await _auth(client)
    project = await _project(client, headers, "Launch")
    task = await _task(client, headers, "Done", project_id=project["id"], status="completed")

    archived = await client.patch(
        f"/api/tasks/{task['id']}", json={"status": "archived"}, headers=headers
    )

    assert archived.status_code == 200, archived.text
    assert await _progress(client, project["id"]) == ZERO


async def test_deleting_a_task_lowers_the_progress(client: AsyncClient) -> None:
    headers = await _auth(client)
    project = await _project(client, headers, "Launch")
    kept = await _task(client, headers, "Kept", project_id=project["id"], status="completed")
    doomed = await _task(client, headers, "Doomed", project_id=project["id"])
    assert await _progress(client, project["id"]) == {"total": 2, "completed": 1, "percent": 50}

    assert (await client.delete(f"/api/tasks/{doomed['id']}", headers=headers)).status_code == 204

    assert await _progress(client, project["id"]) == {"total": 1, "completed": 1, "percent": 100}
    assert kept["id"]  # the surviving task is untouched


async def test_the_project_list_reports_progress_for_every_project(client: AsyncClient) -> None:
    headers = await _auth(client)
    alpha = await _project(client, headers, "Alpha")
    beta = await _project(client, headers, "Beta")
    empty = await _project(client, headers, "Empty")
    await _task(client, headers, "A done", project_id=alpha["id"], status="completed")
    await _task(client, headers, "A open", project_id=alpha["id"])
    await _task(client, headers, "B done", project_id=beta["id"], status="completed")

    listing = (await client.get("/api/projects")).json()["projects"]
    by_id = {project["id"]: project["progress"] for project in listing}

    assert by_id[alpha["id"]] == {"total": 2, "completed": 1, "percent": 50}
    assert by_id[beta["id"]] == {"total": 1, "completed": 1, "percent": 100}
    assert by_id[empty["id"]] == ZERO


async def test_progress_ignores_another_users_tasks_even_if_they_reference_the_project(
    client: AsyncClient,
) -> None:
    """Progress is strictly the caller's tasks, even for a stray cross-user row."""
    headers = await _auth(client)
    project = await _project(client, headers, "Mine")
    await _task(client, headers, "Mine done", project_id=project["id"], status="completed")

    # A row that references the caller's project but belongs to another user. The API would never
    # allow this, so insert it directly to prove the progress query's user scope holds regardless.
    async with session_scope() as session:
        other = User(
            id=uuid.uuid4(),
            email=f"{uuid.uuid4()}@example.com",
            display_name="Other",
            password_hash="not-used",
        )
        session.add(other)
        await session.flush()
        session.add(
            Task(
                user_id=other.id,
                title="Theirs",
                status="inbox",
                project_id=uuid.UUID(project["id"]),
            )
        )
        await session.flush()

    assert await _progress(client, project["id"]) == {"total": 1, "completed": 1, "percent": 100}
