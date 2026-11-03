"""``field_revisions`` upkeep on every write path (SYNC-03a, ADR-0059 D4), non-sync behaviour.

The invariant: after any write, a tracked field whose value changed carries the entity's new
revision, and a field that did not change keeps its old stamp. The merge of 03d relies on it, so
each write path that can change a field is exercised: create, PATCH, restore, delete (subtask
promotion), project delete (unfile) and a project PATCH.
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient

from atlas.sync.fields import PROJECT_FIELDS, TASK_FIELDS
from tests.conftest import create_user_via_setup, csrf_headers

pytestmark = pytest.mark.usefixtures("_db")


@pytest.fixture
async def authed(client: AsyncClient) -> AsyncClient:
    await create_user_via_setup(client)
    return client


async def _task(c: AsyncClient, **body: object) -> dict:
    r = await c.post("/api/tasks", json={"title": "t", **body}, headers=csrf_headers(c))
    assert r.status_code == 201, r.text
    return r.json()


async def _patch(c: AsyncClient, task_id: str, **body: object) -> dict:
    r = await c.patch(f"/api/tasks/{task_id}", json=body, headers=csrf_headers(c))
    assert r.status_code == 200, r.text
    return r.json()


async def test_a_new_task_has_every_tracked_field_at_revision_one(authed: AsyncClient) -> None:
    task = await _task(authed)
    assert task["field_revisions"] == dict.fromkeys(TASK_FIELDS, 1)


async def test_a_patch_stamps_only_the_fields_that_changed(authed: AsyncClient) -> None:
    task = await _task(authed, description="d")
    out = await _patch(authed, task["id"], title="new", description="d", priority="high")
    assert out["revision"] == 2
    stamps = out["field_revisions"]
    assert stamps["title"] == 2 and stamps["priority"] == 2
    assert stamps["description"] == 1, "an equal value is not a change"
    assert stamps["status"] == 1


async def test_a_no_op_patch_bumps_the_revision_but_stamps_nothing(authed: AsyncClient) -> None:
    task = await _task(authed)
    out = await _patch(authed, task["id"], title="t")
    assert out["revision"] == 2  # today's behaviour, unchanged
    assert out["field_revisions"] == dict.fromkeys(TASK_FIELDS, 1)


async def test_completing_stamps_the_server_set_completed_at(authed: AsyncClient) -> None:
    task = await _task(authed)
    out = await _patch(authed, task["id"], status="in_progress")
    out = await _patch(authed, task["id"], status="completed")
    assert out["field_revisions"]["status"] == 3
    assert out["field_revisions"]["completed_at"] == 3


async def test_tags_are_one_tracked_field(authed: AsyncClient) -> None:
    task = await _task(authed, tags=["a", "b"])
    same = await _patch(authed, task["id"], tags=["B", "a"])
    assert same["field_revisions"]["tags"] == 1, "same set, other case/order: unchanged"
    changed = await _patch(authed, task["id"], tags=["a", "c"])
    assert changed["field_revisions"]["tags"] == 3


async def test_deleting_a_parent_stamps_the_promoted_subtask(authed: AsyncClient) -> None:
    parent = await _task(authed)
    child = await _task(authed, parent_task_id=parent["id"])
    r = await authed.delete(f"/api/tasks/{parent['id']}", headers=csrf_headers(authed))
    assert r.status_code == 204
    got = (await authed.get(f"/api/tasks/{child['id']}")).json()
    assert got["parent_task_id"] is None
    assert got["revision"] == 2 and got["field_revisions"]["parent_task_id"] == 2
    assert got["field_revisions"]["title"] == 1


async def test_deleting_a_project_stamps_the_unfiled_task(authed: AsyncClient) -> None:
    p = await authed.post("/api/projects", json={"name": "p"}, headers=csrf_headers(authed))
    project = p.json()
    assert project["field_revisions"] == dict.fromkeys(PROJECT_FIELDS, 1)
    task = await _task(authed, project_id=project["id"])
    await authed.delete(f"/api/projects/{project['id']}", headers=csrf_headers(authed))
    got = (await authed.get(f"/api/tasks/{task['id']}")).json()
    assert got["project_id"] is None
    assert got["revision"] == 2 and got["field_revisions"]["project_id"] == 2


async def test_restore_into_a_deleted_project_stamps_project_id(authed: AsyncClient) -> None:
    project = (
        await authed.post("/api/projects", json={"name": "p"}, headers=csrf_headers(authed))
    ).json()
    task = await _task(authed, project_id=project["id"])
    await authed.delete(f"/api/tasks/{task['id']}", headers=csrf_headers(authed))
    await authed.delete(f"/api/projects/{project['id']}", headers=csrf_headers(authed))
    r = await authed.post(f"/api/tasks/{task['id']}/restore", headers=csrf_headers(authed))
    out = r.json()
    assert out["project_id"] is None
    assert out["field_revisions"]["project_id"] == out["revision"]
    assert out["field_revisions"]["title"] == 1


async def test_a_project_patch_stamps_changed_fields(authed: AsyncClient) -> None:
    project = (
        await authed.post("/api/projects", json={"name": "p"}, headers=csrf_headers(authed))
    ).json()
    r = await authed.patch(
        f"/api/projects/{project['id']}",
        json={"name": "q", "status": "active", "target_date": "2030-01-01"},
        headers=csrf_headers(authed),
    )
    stamps = r.json()["field_revisions"]
    assert stamps["name"] == 2 and stamps["target_date"] == 2
    assert stamps["status"] == 1 and stamps["description"] == 1


async def test_a_generated_recurrence_occurrence_starts_at_revision_one(
    authed: AsyncClient,
) -> None:
    task = await _task(authed, due_at="2030-01-01T09:00:00Z", recurrence_rule="FREQ=DAILY")
    await _patch(authed, task["id"], status="in_progress")
    await _patch(authed, task["id"], status="completed")
    listing = (await authed.get("/api/tasks")).json()["tasks"]
    successor = next(t for t in listing if t["id"] != task["id"])
    assert successor["field_revisions"] == dict.fromkeys(TASK_FIELDS, 1)
