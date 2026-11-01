"""Subtasks (M3-06) against a real PostgreSQL over HTTP.

Covers the acceptance criteria: creating a subtask and listing it on the parent; rejecting
self-parenting, cycles (at depth > 1), cross-user parenting and a missing/soft-deleted parent
without changing state; project inheritance; the derived completion rollup (which never completes
the parent); promoting subtasks when the parent is soft-deleted; and the recurrence interaction
(a generated occurrence does not clone the parent's subtasks). Requires a database (``client``
pulls in ``_db``).
"""

from __future__ import annotations

import uuid

from httpx import AsyncClient

from atlas.db import session_scope
from atlas.models import Task, User
from tests.conftest import create_user_via_setup, csrf_headers


async def _auth(client: AsyncClient) -> dict[str, str]:
    await create_user_via_setup(client)
    return csrf_headers(client)


async def _create(client: AsyncClient, headers: dict[str, str], **payload: object) -> dict:
    response = await client.post("/api/tasks", json={"title": "T", **payload}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


async def _get(client: AsyncClient, task_id: str) -> dict:
    response = await client.get(f"/api/tasks/{task_id}")
    assert response.status_code == 200, response.text
    return response.json()


async def _project(client: AsyncClient, headers: dict[str, str], name: str) -> str:
    """Create a real project (the FK requires one) and return its id."""
    response = await client.post("/api/projects", json={"name": name}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()["id"]


async def test_a_subtask_is_created_and_listed_on_its_parent(client: AsyncClient) -> None:
    headers = await _auth(client)
    parent = await _create(client, headers, title="Parent")
    child = await _create(client, headers, title="Child", parent_task_id=parent["id"])
    assert child["parent_task_id"] == parent["id"]

    listing = await client.get("/api/tasks", params={"parent_task_id": parent["id"]})
    assert listing.status_code == 200
    assert [task["id"] for task in listing.json()["tasks"]] == [child["id"]]

    all_ids = {task["id"] for task in (await client.get("/api/tasks")).json()["tasks"]}
    assert all_ids == {parent["id"], child["id"]}


async def test_listing_subtasks_of_a_missing_parent_is_not_found(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    await _create(client, headers, title="Parent")
    response = await client.get("/api/tasks", params={"parent_task_id": str(uuid.uuid4())})
    assert response.status_code == 404


async def test_a_task_cannot_be_its_own_parent(client: AsyncClient) -> None:
    headers = await _auth(client)
    task = await _create(client, headers, title="Self")
    response = await client.patch(
        f"/api/tasks/{task['id']}", json={"parent_task_id": task["id"]}, headers=headers
    )
    assert response.status_code == 400
    unchanged = await _get(client, task["id"])
    assert unchanged["parent_task_id"] is None
    assert unchanged["revision"] == task["revision"]  # nothing changed


async def test_a_direct_cycle_is_rejected_without_changing_state(client: AsyncClient) -> None:
    headers = await _auth(client)
    a = await _create(client, headers, title="A")
    b = await _create(client, headers, title="B", parent_task_id=a["id"])

    response = await client.patch(
        f"/api/tasks/{a['id']}", json={"parent_task_id": b["id"]}, headers=headers
    )
    assert response.status_code == 400
    assert (await _get(client, a["id"]))["parent_task_id"] is None
    # b is still a subtask of a.
    assert (await _get(client, b["id"]))["parent_task_id"] == a["id"]


async def test_a_cycle_at_depth_greater_than_one_is_rejected(client: AsyncClient) -> None:
    headers = await _auth(client)
    a = await _create(client, headers, title="A")
    b = await _create(client, headers, title="B", parent_task_id=a["id"])
    c = await _create(client, headers, title="C", parent_task_id=b["id"])

    response = await client.patch(
        f"/api/tasks/{a['id']}", json={"parent_task_id": c["id"]}, headers=headers
    )
    assert response.status_code == 400
    assert (await _get(client, a["id"]))["parent_task_id"] is None


async def test_a_task_cannot_be_parented_under_another_users_task(client: AsyncClient) -> None:
    headers = await _auth(client)
    other_task_id = uuid.uuid4()
    async with session_scope() as session:
        other = User(
            id=uuid.uuid4(),
            email=f"{uuid.uuid4()}@example.com",
            display_name="Other",
            password_hash="not-used",
        )
        session.add(other)
        await session.flush()
        session.add(Task(id=other_task_id, user_id=other.id, title="Other's task"))
        await session.flush()

    response = await client.post(
        "/api/tasks",
        json={"title": "child", "parent_task_id": str(other_task_id)},
        headers=headers,
    )
    assert response.status_code == 400
    # The rejected create left no task behind for the current user.
    assert (await client.get("/api/tasks")).json()["tasks"] == []


async def test_a_soft_deleted_parent_is_rejected(client: AsyncClient) -> None:
    headers = await _auth(client)
    parent = await _create(client, headers, title="Parent")
    assert (await client.delete(f"/api/tasks/{parent['id']}", headers=headers)).status_code == 204

    response = await client.post(
        "/api/tasks",
        json={"title": "child", "parent_task_id": parent["id"]},
        headers=headers,
    )
    assert response.status_code == 400


async def test_a_subtask_inherits_the_parents_project(client: AsyncClient) -> None:
    headers = await _auth(client)
    project = await _project(client, headers, "Alpha")
    parent = await _create(client, headers, title="Parent", project_id=project)

    inherited = await _create(client, headers, title="Child", parent_task_id=parent["id"])
    assert inherited["project_id"] == project

    # Sending the parent's own project explicitly is accepted.
    explicit = await _create(
        client,
        headers,
        title="Child2",
        parent_task_id=parent["id"],
        project_id=parent["project_id"],
    )
    assert explicit["project_id"] == project


async def test_a_subtask_with_a_conflicting_project_is_rejected(client: AsyncClient) -> None:
    headers = await _auth(client)
    project = await _project(client, headers, "Alpha")
    other_project = await _project(client, headers, "Beta")
    parent = await _create(client, headers, title="Parent", project_id=project)

    response = await client.post(
        "/api/tasks",
        json={
            "title": "child",
            "parent_task_id": parent["id"],
            "project_id": other_project,
        },
        headers=headers,
    )
    assert response.status_code == 400
    assert [task["title"] for task in (await client.get("/api/tasks")).json()["tasks"]] == [
        "Parent"
    ]


async def test_the_rollup_tracks_the_subtasks_without_completing_the_parent(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    parent = await _create(client, headers, title="Parent")
    first = await _create(client, headers, title="One", parent_task_id=parent["id"])
    second = await _create(client, headers, title="Two", parent_task_id=parent["id"])

    fetched = await _get(client, parent["id"])
    assert (fetched["subtasks_total"], fetched["subtasks_done"]) == (2, 0)

    completed = await client.patch(
        f"/api/tasks/{first['id']}", json={"status": "completed"}, headers=headers
    )
    assert completed.status_code == 200
    fetched = await _get(client, parent["id"])
    assert (fetched["subtasks_total"], fetched["subtasks_done"]) == (2, 1)
    assert fetched["status"] == "inbox"  # completing a subtask never completes the parent

    await client.patch(f"/api/tasks/{second['id']}", json={"status": "completed"}, headers=headers)
    fetched = await _get(client, parent["id"])
    assert (fetched["subtasks_total"], fetched["subtasks_done"]) == (2, 2)
    assert fetched["status"] == "inbox"  # still not auto-completed

    # The list endpoint carries the same derived counts.
    listed = next(
        task
        for task in (await client.get("/api/tasks")).json()["tasks"]
        if task["id"] == parent["id"]
    )
    assert (listed["subtasks_total"], listed["subtasks_done"]) == (2, 2)


async def test_soft_deleting_a_parent_promotes_its_subtasks(client: AsyncClient) -> None:
    headers = await _auth(client)
    parent = await _create(client, headers, title="Parent")
    child = await _create(client, headers, title="Child", parent_task_id=parent["id"])

    assert (await client.delete(f"/api/tasks/{parent['id']}", headers=headers)).status_code == 204

    promoted = await _get(client, child["id"])
    assert promoted["parent_task_id"] is None  # promoted to a top-level task
    ids = {task["id"] for task in (await client.get("/api/tasks")).json()["tasks"]}
    assert ids == {child["id"]}  # the child survives; the parent is hidden
    assert (await client.get(f"/api/tasks/{parent['id']}")).status_code == 404


async def test_completing_a_recurring_task_does_not_clone_its_subtasks(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    head = await _create(
        client,
        headers,
        title="Stand-up",
        due_at="2026-01-02T09:00:00Z",
        recurrence_rule="FREQ=DAILY;COUNT=3",
    )
    subtask = await _create(client, headers, title="Prep", parent_task_id=head["id"])

    completed = await client.patch(
        f"/api/tasks/{head['id']}", json={"status": "completed"}, headers=headers
    )
    assert completed.status_code == 200

    tasks = (await client.get("/api/tasks")).json()["tasks"]
    occurrences = [task for task in tasks if task["recurrence_parent_id"] == head["id"]]
    assert len(occurrences) == 1
    occurrence = occurrences[0]
    assert occurrence["parent_task_id"] is None  # an occurrence is always top-level

    # The occurrence carries no subtasks.
    assert (await client.get("/api/tasks", params={"parent_task_id": occurrence["id"]})).json()[
        "tasks"
    ] == []

    # The original subtask still belongs to the (completed) head, whose rollup still counts it.
    assert (await _get(client, subtask["id"]))["parent_task_id"] == head["id"]
    assert (await _get(client, head["id"]))["subtasks_total"] == 1
