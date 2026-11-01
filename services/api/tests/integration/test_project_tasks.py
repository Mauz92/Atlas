"""Task↔project association (M4-02) against a real PostgreSQL over HTTP.

Covers the M4-02 acceptance criteria: a task can be assigned to a project on create and moved
between projects (or unfiled) with ``PATCH``; membership is optional; a project's tasks can be
listed both through ``GET /api/projects/{id}/tasks`` and through the ``project_id`` filter on
``GET /api/tasks``; an unknown or another user's project is rejected with no side effects; and the
documented project tombstone behaviour — a project delete never deletes its tasks, it *unfiles* the
live ones (clearing ``project_id`` and bumping their ``revision``) while leaving already-tombstoned
tasks untouched (ADR-0021).

Requires a database (``client`` pulls in ``_db``).
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from atlas.db import session_scope
from atlas.models import Project, Task, User
from tests.conftest import create_user_via_setup, csrf_headers

if TYPE_CHECKING:
    from httpx import AsyncClient


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


async def _patch_task(
    client: AsyncClient, headers: dict[str, str], task_id: str, **payload: object
) -> dict:
    response = await client.patch(f"/api/tasks/{task_id}", json=payload, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


async def _project_tasks(client: AsyncClient, project_id: str) -> list[dict]:
    """The tasks the project endpoint reports, asserting it answered ``200``."""
    response = await client.get(f"/api/projects/{project_id}/tasks")
    assert response.status_code == 200, response.text
    return response.json()["tasks"]


async def _filtered(client: AsyncClient, project_id: str) -> list[str]:
    """The titles the ``project_id`` list filter reports."""
    response = await client.get("/api/tasks", params={"project_id": project_id})
    assert response.status_code == 200, response.text
    return [task["title"] for task in response.json()["tasks"]]


async def _seed_foreign_project() -> tuple[str, str]:
    """Another user's project with one task; returns ``(project_id, task_id)``.

    The API is never used for this: the second account exists only to prove that its project is
    invisible to the authenticated caller.
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
        project = Project(id=uuid.uuid4(), user_id=other.id, name="Theirs")
        session.add(project)
        await session.flush()
        task = Task(user_id=other.id, title="Their task", project_id=project.id)
        session.add(task)
        await session.flush()
        return str(project.id), str(task.id)


async def _stored_task(task_id: str) -> tuple[str | None, int, bool]:
    """Read the row directly: ``(project_id, revision, deleted)``."""
    async with session_scope() as session:
        row = await session.get(Task, uuid.UUID(task_id))
        assert row is not None
        return (
            str(row.project_id) if row.project_id else None,
            row.revision,
            row.deleted_at is not None,
        )


# --- assigning and moving ------------------------------------------------------


async def test_a_task_can_be_created_in_a_project(client: AsyncClient) -> None:
    headers = await _auth(client)
    project = await _project(client, headers, "Launch")

    task = await _task(client, headers, title="Ship it", project_id=project["id"])

    assert task["project_id"] == project["id"]
    assert task["revision"] == 1
    assert [t["id"] for t in await _project_tasks(client, project["id"])] == [task["id"]]
    assert await _filtered(client, project["id"]) == ["Ship it"]


async def test_a_task_can_move_between_projects(client: AsyncClient) -> None:
    headers = await _auth(client)
    alpha = await _project(client, headers, "Alpha")
    beta = await _project(client, headers, "Beta")
    task = await _task(client, headers, title="Move me", project_id=alpha["id"])

    moved = await _patch_task(client, headers, task["id"], project_id=beta["id"])

    assert moved["project_id"] == beta["id"]
    assert moved["revision"] == task["revision"] + 1
    assert await _project_tasks(client, alpha["id"]) == []
    assert [t["id"] for t in await _project_tasks(client, beta["id"])] == [task["id"]]


async def test_membership_can_be_cleared_and_is_optional(client: AsyncClient) -> None:
    headers = await _auth(client)
    project = await _project(client, headers, "Alpha")
    filed = await _task(client, headers, title="Filed", project_id=project["id"])
    unfiled = await _task(client, headers, title="Never filed")

    cleared = await _patch_task(client, headers, filed["id"], project_id=None)

    assert unfiled["project_id"] is None  # a task without a project is the default, unaffected
    assert cleared["project_id"] is None
    assert cleared["revision"] == filed["revision"] + 1
    assert await _project_tasks(client, project["id"]) == []
    # The task itself is untouched apart from its membership: still readable, still listed.
    assert (await client.get(f"/api/tasks/{filed['id']}")).json()["title"] == "Filed"
    listing = (await client.get("/api/tasks")).json()["tasks"]
    assert {task["title"] for task in listing} == {"Filed", "Never filed"}


# --- listing a project's tasks -------------------------------------------------


async def test_a_projects_tasks_are_listed_and_match_the_project_filter(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    alpha = await _project(client, headers, "Alpha")
    beta = await _project(client, headers, "Beta")
    await _task(client, headers, title="Alpha one", project_id=alpha["id"])
    await _task(client, headers, title="Alpha two", project_id=alpha["id"], priority="high")
    await _task(client, headers, title="Beta one", project_id=beta["id"])
    await _task(client, headers, title="Unfiled")

    listed = await _project_tasks(client, alpha["id"])

    assert {t["title"] for t in listed} == {"Alpha one", "Alpha two"}
    assert all(t["project_id"] == alpha["id"] for t in listed)
    assert "Unfiled" not in {t["title"] for t in listed}
    # Same set and same ordering as the M3-08 ``project_id`` list filter (most urgent first).
    filter_ids = [
        t["id"]
        for t in (await client.get("/api/tasks", params={"project_id": alpha["id"]})).json()[
            "tasks"
        ]
    ]
    assert [t["id"] for t in listed] == filter_ids


async def test_a_project_listing_reports_unknown_and_foreign_projects_as_missing(
    client: AsyncClient,
) -> None:
    await _auth(client)
    foreign_project_id, _ = await _seed_foreign_project()

    assert (await client.get(f"/api/projects/{uuid.uuid4()}/tasks")).status_code == 404
    assert (await client.get(f"/api/projects/{foreign_project_id}/tasks")).status_code == 404
    # The object does not leak through the filter either (ADR-0018: unknown ids match nothing).
    assert await _filtered(client, foreign_project_id) == []


async def test_a_foreign_projects_tasks_are_invisible(client: AsyncClient) -> None:
    headers = await _auth(client)
    project = await _project(client, headers, "Mine")
    mine = await _task(client, headers, title="Mine", project_id=project["id"])
    foreign_project_id, foreign_task_id = await _seed_foreign_project()

    assert [t["id"] for t in await _project_tasks(client, project["id"])] == [mine["id"]]
    assert (await client.get(f"/api/tasks/{foreign_task_id}")).status_code == 404
    assert await _filtered(client, foreign_project_id) == []


async def test_the_project_listing_rejects_an_out_of_range_limit(client: AsyncClient) -> None:
    headers = await _auth(client)
    project = await _project(client, headers, "Alpha")

    assert (
        await client.get(f"/api/projects/{project['id']}/tasks", params={"limit": 0})
    ).status_code == 422
    assert (
        await client.get(f"/api/projects/{project['id']}/tasks", params={"limit": 501})
    ).status_code == 422


# --- validation ----------------------------------------------------------------


async def test_creating_with_an_unknown_project_is_rejected_without_side_effects(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    before = (await client.get("/api/tasks")).json()

    response = await client.post(
        "/api/tasks", json={"title": "Orphan", "project_id": str(uuid.uuid4())}, headers=headers
    )

    assert response.status_code == 400, response.text
    assert response.json()["detail"] == "project does not exist"
    assert (await client.get("/api/tasks")).json() == before


async def test_moving_to_an_unknown_or_foreign_project_is_rejected_without_side_effects(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    project = await _project(client, headers, "Alpha")
    task = await _task(client, headers, title="Filed", project_id=project["id"])
    foreign_project_id, _ = await _seed_foreign_project()

    unknown = await client.patch(
        f"/api/tasks/{task['id']}", json={"project_id": str(uuid.uuid4())}, headers=headers
    )
    foreign = await client.patch(
        f"/api/tasks/{task['id']}", json={"project_id": foreign_project_id}, headers=headers
    )

    assert unknown.status_code == 400, unknown.text
    assert foreign.status_code == 400, foreign.text
    unchanged = (await client.get(f"/api/tasks/{task['id']}")).json()
    assert unchanged["project_id"] == project["id"]
    assert unchanged["revision"] == task["revision"]


async def test_a_subtask_cannot_be_moved_to_another_project(client: AsyncClient) -> None:
    headers = await _auth(client)
    alpha = await _project(client, headers, "Alpha")
    beta = await _project(client, headers, "Beta")
    parent = await _task(client, headers, title="Parent", project_id=alpha["id"])
    child = await _task(client, headers, title="Child", parent_task_id=parent["id"])
    assert child["project_id"] == alpha["id"]  # inherited from the parent (ADR-0016)

    response = await client.patch(
        f"/api/tasks/{child['id']}", json={"project_id": beta["id"]}, headers=headers
    )

    assert response.status_code == 400, response.text
    assert (await client.get(f"/api/tasks/{child['id']}")).json()["project_id"] == alpha["id"]


# --- project tombstone (ADR-0021) ----------------------------------------------


async def test_deleting_a_project_unfiles_its_live_tasks(client: AsyncClient) -> None:
    headers = await _auth(client)
    project = await _project(client, headers, "Doomed")
    one = await _task(client, headers, title="One", project_id=project["id"])
    two = await _task(client, headers, title="Two", project_id=project["id"])
    unrelated = await _task(client, headers, title="Unfiled")

    assert (
        await client.delete(f"/api/projects/{project['id']}", headers=headers)
    ).status_code == 204

    for before in (one, two):
        stored = await _stored_task(before["id"])
        assert stored == (None, before["revision"] + 1, False)  # unfiled, still live
        assert (await client.get(f"/api/tasks/{before['id']}")).json()["project_id"] is None
    # The project is gone from the API, and the old id now matches nothing (M3-08 semantics).
    assert (await client.get(f"/api/projects/{project['id']}/tasks")).status_code == 404
    assert await _filtered(client, project["id"]) == []
    # Tasks that were never filed are untouched.
    assert (await _stored_task(unrelated["id"]))[1] == unrelated["revision"]


async def test_the_unfiling_appears_in_the_change_feed(client: AsyncClient) -> None:
    headers = await _auth(client)
    project = await _project(client, headers, "Doomed")
    task = await _task(client, headers, title="One", project_id=project["id"])
    cursor = (await client.get("/api/tasks/changes", params={"since": 0})).json()["next_since"]

    await client.delete(f"/api/projects/{project['id']}", headers=headers)

    feed = (await client.get("/api/tasks/changes", params={"since": cursor})).json()
    assert [item["id"] for item in feed["tasks"]] == [task["id"]]
    assert feed["tasks"][0]["project_id"] is None
    assert feed["tasks"][0]["revision"] == task["revision"] + 1
    assert feed["tasks"][0]["deleted_at"] is None  # an update, not a tombstone


async def test_deleting_a_project_leaves_already_deleted_tasks_untouched(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    project = await _project(client, headers, "Doomed")
    live = await _task(client, headers, title="Live", project_id=project["id"])
    gone = await _task(client, headers, title="Gone", project_id=project["id"])
    assert (await client.delete(f"/api/tasks/{gone['id']}", headers=headers)).status_code == 204
    tombstoned = await _stored_task(gone["id"])

    await client.delete(f"/api/projects/{project['id']}", headers=headers)

    # Only the live task is unfiled; the tombstone keeps its row exactly as it was.
    assert await _stored_task(gone["id"]) == tombstoned
    assert (await _stored_task(live["id"]))[0] is None


async def test_a_task_cannot_be_moved_into_a_deleted_project(client: AsyncClient) -> None:
    headers = await _auth(client)
    project = await _project(client, headers, "Doomed")
    task = await _task(client, headers, title="Kept", project_id=project["id"])
    await client.delete(f"/api/projects/{project['id']}", headers=headers)

    response = await client.patch(
        f"/api/tasks/{task['id']}", json={"project_id": project["id"]}, headers=headers
    )

    assert response.status_code == 400, response.text
    assert (await client.get(f"/api/tasks/{task['id']}")).json()["project_id"] is None


# --- interaction with recurrence ------------------------------------------------


async def test_a_recurring_task_keeps_its_project_across_occurrences(
    client: AsyncClient,
) -> None:
    """M4-02 must not regress M3-05: an occurrence inherits the project and loses it too."""
    headers = await _auth(client)
    project = await _project(client, headers, "Stand-up project")
    head = await _task(
        client,
        headers,
        title="Stand-up",
        project_id=project["id"],
        due_at="2026-11-02T09:00:00Z",
        recurrence_rule="FREQ=WEEKLY",
    )

    completed = await _patch_task(client, headers, head["id"], status="completed")

    assert completed["project_id"] == project["id"]
    occurrences = await _project_tasks(client, project["id"])
    assert len(occurrences) == 2
    assert all(item["project_id"] == project["id"] for item in occurrences)

    await client.delete(f"/api/projects/{project['id']}", headers=headers)

    for item in occurrences:
        assert (await client.get(f"/api/tasks/{item['id']}")).json()["project_id"] is None
