"""Sync-mode writes for tasks and projects (SYNC-03c/03d; SYNC_PROTOCOL.md 6.1, 6.2).

Client-generated ids, the required key/base, unknown-field refusal, the field-level merge (ADR-0055
section 4 rules 1-4) and edit-wins-over-delete. Every behaviour is also shown to be absent without
``Atlas-Sync: 1`` (the web app is unchanged).
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from httpx import AsyncClient, Response

from atlas.db import session_scope
from atlas.models import Task, User
from tests.conftest import create_user_via_setup, csrf_headers

pytestmark = pytest.mark.usefixtures("_db")


@pytest.fixture
async def c(client: AsyncClient) -> AsyncClient:
    await create_user_via_setup(client)
    return client


def h(c: AsyncClient, key: str | None = None, **extra: str) -> dict[str, str]:
    return {
        "Atlas-Sync": "1",
        "Idempotency-Key": key or str(uuid.uuid4()),
        **csrf_headers(c),
        **extra,
    }


async def new_task(c: AsyncClient, **body: Any) -> dict:
    r = await c.post("/api/tasks", json={"title": "t", **body}, headers=h(c))
    assert r.status_code == 201, r.text
    return r.json()


async def patch(c: AsyncClient, task: dict, base: int | None = None, **body: Any) -> Response:
    payload = {"base_revision": task["revision"] if base is None else base, **body}
    return await c.patch(f"/api/tasks/{task['id']}", json=payload, headers=h(c))


async def get(c: AsyncClient, kind: str, entity_id: str) -> Response:
    return await c.get(f"/api/{kind}/{entity_id}")


# --- client ids (03c) ---------------------------------------------------------------------------


async def test_a_client_id_is_used_and_the_create_is_idempotent_by_id(c: AsyncClient) -> None:
    cid = str(uuid.uuid4())
    first = await c.post("/api/tasks", json={"id": cid, "title": "t"}, headers=h(c))
    assert first.status_code == 201 and first.json()["id"] == cid
    assert first.json()["sync"] == {"revision": 1, "resolution": [], "conflicts": []}
    again = await c.post("/api/tasks", json={"id": cid, "title": "t"}, headers=h(c))  # new key
    assert again.status_code == 201 and again.json()["id"] == cid
    assert again.headers["Idempotency-Replayed"] == "true"
    assert len((await c.get("/api/tasks")).json()["tasks"]) == 1


async def test_the_same_key_replays_the_stored_response(c: AsyncClient) -> None:
    key = str(uuid.uuid4())
    a = await c.post("/api/tasks", json={"title": "t"}, headers=h(c, key))
    b = await c.post("/api/tasks", json={"title": "t"}, headers=h(c, key))
    assert b.status_code == 201 and b.json() == a.json()
    assert b.headers["Idempotency-Replayed"] == "true"
    assert len((await c.get("/api/tasks")).json()["tasks"]) == 1
    other = await c.post("/api/tasks", json={"title": "different"}, headers=h(c, key))
    assert other.status_code == 409 and other.json()["error"] == "idempotency_mismatch"


async def test_a_taken_id_with_another_body_is_409_id_exists(c: AsyncClient) -> None:
    cid = str(uuid.uuid4())
    await c.post("/api/tasks", json={"id": cid, "title": "t"}, headers=h(c))
    r = await c.post("/api/tasks", json={"id": cid, "title": "other"}, headers=h(c))
    assert r.status_code == 409 and r.json()["error"] == "id_exists"
    assert (await get(c, "tasks", cid)).json()["title"] == "t"


async def test_an_edited_task_no_longer_replays_by_id(c: AsyncClient) -> None:
    task = await new_task(c, id=str(uuid.uuid4()))
    assert (await patch(c, task, title="x")).status_code == 200
    r = await c.post("/api/tasks", json={"id": task["id"], "title": "t"}, headers=h(c))
    assert r.status_code == 409 and r.json()["error"] == "id_exists"


async def test_a_deleted_task_keeps_its_id_reserved(c: AsyncClient) -> None:
    task = await new_task(c, id=str(uuid.uuid4()))
    await c.delete(f"/api/tasks/{task['id']}", params={"base_revision": 1}, headers=h(c))
    r = await c.post("/api/tasks", json={"id": task["id"], "title": "t"}, headers=h(c))
    assert r.status_code == 409 and r.json()["error"] == "id_exists"


async def test_another_users_id_is_indistinguishable_from_a_taken_one(c: AsyncClient) -> None:
    foreign = uuid.uuid4()
    async with session_scope() as session:
        other = User(email="other@example.com", display_name="O", password_hash="x")
        session.add(other)
        await session.flush()
        session.add(Task(id=foreign, user_id=other.id, title="secret"))
    r = await c.post("/api/tasks", json={"id": str(foreign), "title": "secret"}, headers=h(c))
    mine = await c.post("/api/tasks", json={"id": str(uuid.uuid4()), "title": "a"}, headers=h(c))
    clash = await c.post("/api/tasks", json={"id": mine.json()["id"], "title": "b"}, headers=h(c))
    assert r.status_code == clash.status_code == 409
    assert r.json() == clash.json()


async def test_a_client_id_is_also_accepted_without_sync_mode(c: AsyncClient) -> None:
    cid = str(uuid.uuid4())
    r = await c.post("/api/tasks", json={"id": cid, "title": "t"}, headers=csrf_headers(c))
    assert r.status_code == 201 and r.json()["id"] == cid and r.json()["sync"] is None


async def test_a_project_client_id_is_idempotent(c: AsyncClient) -> None:
    cid = str(uuid.uuid4())
    a = await c.post("/api/projects", json={"id": cid, "name": "p"}, headers=h(c))
    b = await c.post("/api/projects", json={"id": cid, "name": "p"}, headers=h(c))
    assert a.status_code == b.status_code == 201 and b.json()["id"] == cid
    bad = await c.post("/api/projects", json={"id": cid, "name": "q"}, headers=h(c))
    assert bad.status_code == 409 and bad.json()["error"] == "id_exists"


async def test_a_subtask_can_reference_a_task_created_with_a_client_id(c: AsyncClient) -> None:
    parent_id = str(uuid.uuid4())
    await new_task(c, id=parent_id)
    child = await new_task(c, parent_task_id=parent_id)
    assert child["parent_task_id"] == parent_id


# --- sync-mode requirements -----------------------------------------------------------------------


async def test_sync_mode_requires_a_key_a_base_and_known_fields(c: AsyncClient) -> None:
    task = await new_task(c)
    no_key = await c.post(
        "/api/tasks",
        json={"title": "x"},
        headers={"Atlas-Sync": "1", **csrf_headers(c)},
    )
    assert no_key.status_code == 422 and no_key.json()["error"] == "idempotency_key_required"
    no_base = await c.patch(f"/api/tasks/{task['id']}", json={"title": "x"}, headers=h(c))
    assert no_base.status_code == 422 and no_base.json()["error"] == "base_revision_required"
    no_base_del = await c.delete(f"/api/tasks/{task['id']}", headers=h(c))
    assert (
        no_base_del.status_code == 422 and no_base_del.json()["error"] == "base_revision_required"
    )
    unknown = await c.post("/api/tasks", json={"title": "x", "colour": "red"}, headers=h(c))
    assert unknown.status_code == 422 and unknown.json()["fields"] == ["colour"]
    unknown_patch = await patch(c, task, bogus=1)
    assert unknown_patch.status_code == 422 and unknown_patch.json()["error"] == "unknown_fields"
    assert (await get(c, "tasks", task["id"])).json()["revision"] == 1


async def test_without_sync_mode_nothing_is_required_or_refused(c: AsyncClient) -> None:
    plain = csrf_headers(c)
    r = await c.post("/api/tasks", json={"title": "x", "colour": "red"}, headers=plain)
    assert r.status_code == 201
    p = await c.patch(f"/api/tasks/{r.json()['id']}", json={"title": "y"}, headers=plain)
    assert p.status_code == 200 and p.json()["sync"] is None
    d = await c.delete(f"/api/tasks/{r.json()['id']}", headers=plain)
    assert d.status_code == 204


async def test_a_base_from_the_future_is_stale(c: AsyncClient) -> None:
    task = await new_task(c)
    r = await patch(c, task, base=9, title="x")
    assert r.status_code == 409
    assert r.json() == {
        "error": "stale",
        "detail": r.json()["detail"],
        "current_revision": 1,
    }


async def test_an_unknown_task_is_404_not_found(c: AsyncClient) -> None:
    r = await c.patch(
        f"/api/tasks/{uuid.uuid4()}", json={"base_revision": 1, "title": "x"}, headers=h(c)
    )
    assert r.status_code == 404 and r.json()["error"] == "not_found"


# --- field-level merge (03d) ---------------------------------------------------------------------


async def test_different_fields_merge(c: AsyncClient) -> None:
    task = await new_task(c)
    a = await patch(c, task, title="from A")
    b = await patch(c, task, priority="high")  # based on revision 1, after A
    assert a.status_code == b.status_code == 200
    out = b.json()
    assert out["title"] == "from A" and out["priority"] == "high" and out["revision"] == 3
    assert out["sync"]["resolution"] == [] and out["sync"]["conflicts"] == []
    assert out["field_revisions"]["title"] == 2 and out["field_revisions"]["priority"] == 3


async def test_the_same_simple_field_takes_the_later_value_and_reports_it(c: AsyncClient) -> None:
    task = await new_task(c)
    await patch(c, task, priority="high")
    r = await patch(c, task, priority="low")
    out = r.json()
    assert r.status_code == 200 and out["priority"] == "low" and out["revision"] == 3
    (resolution,) = out["sync"]["resolution"]
    assert resolution["rule"] == "simple_later_wins" and resolution["field"] == "priority"
    assert resolution["loser"] == "high" and resolution["kept_revision"] == 3


async def test_the_same_text_field_is_a_conflict_that_keeps_both(c: AsyncClient) -> None:
    task = await new_task(c)
    await patch(c, task, title="from A")
    r = await patch(c, task, title="from B")
    assert r.status_code == 409
    body = r.json()
    assert body["error"] == "conflict" and body["current_revision"] == 2
    assert body["conflicts"] == [
        {
            "field": "title",
            "reason": "text_conflict",
            "server_revision": 2,
            "server_value": "from A",
        }
    ]
    now = (await get(c, "tasks", task["id"])).json()
    assert now["title"] == "from A" and now["revision"] == 2, "nothing was applied"


async def test_a_text_conflict_does_not_block_the_other_fields(c: AsyncClient) -> None:
    task = await new_task(c)
    await patch(c, task, title="from A")
    r = await patch(c, task, title="from B", priority="urgent")
    out = r.json()
    assert r.status_code == 200 and out["title"] == "from A" and out["priority"] == "urgent"
    assert [x["field"] for x in out["sync"]["conflicts"]] == ["title"]
    assert out["revision"] == 3


async def test_an_equal_value_is_a_no_op_without_a_revision_bump(c: AsyncClient) -> None:
    task = await new_task(c)
    await patch(c, task, title="same")
    r = await patch(c, task, title="same")
    assert r.status_code == 200 and r.json()["revision"] == 2
    assert r.json()["sync"]["conflicts"] == []


async def test_a_later_wins_status_may_not_break_the_state_machine(c: AsyncClient) -> None:
    task = await new_task(c)
    assert (await patch(c, task, status="archived")).status_code == 200
    r = await patch(c, task, status="completed", priority="low")  # inbox -> completed, but archived
    out = r.json()
    assert r.status_code == 200 and out["status"] == "archived" and out["priority"] == "low"
    (conflict,) = out["sync"]["conflicts"]
    assert conflict["field"] == "status" and conflict["reason"] == "invalid_transition"
    only = await patch(c, task, status="completed")
    assert only.status_code == 409 and only.json()["conflicts"][0]["reason"] == "invalid_transition"


async def test_completing_twice_on_two_devices_is_not_a_conflict(c: AsyncClient) -> None:
    task = await new_task(c, due_at="2030-01-01T09:00:00Z", recurrence_rule="FREQ=DAILY")
    one = await patch(c, task, status="completed")
    two = await patch(c, task, status="completed")
    assert one.status_code == two.status_code == 200
    assert two.json()["revision"] == one.json()["revision"], "the second completion is a no-op"
    tasks = (await c.get("/api/tasks")).json()["tasks"]
    assert len(tasks) == 2, "exactly one successor occurrence"


async def test_tags_merge_as_one_simple_field(c: AsyncClient) -> None:
    task = await new_task(c, tags=["a"])
    await patch(c, task, tags=["a", "b"])
    r = await patch(c, task, tags=["c"])
    out = r.json()
    assert out["tags"] == ["c"] and out["sync"]["resolution"][0]["field"] == "tags"
    assert out["sync"]["resolution"][0]["loser"] == ["a", "b"]


async def test_a_retried_patch_applies_once(c: AsyncClient) -> None:
    task = await new_task(c)
    key = str(uuid.uuid4())
    body = {"base_revision": 1, "title": "x"}
    a = await c.patch(f"/api/tasks/{task['id']}", json=body, headers=h(c, key))
    b = await c.patch(f"/api/tasks/{task['id']}", json=body, headers=h(c, key))
    assert a.json() == b.json() and b.headers["Idempotency-Replayed"] == "true"
    assert (await get(c, "tasks", task["id"])).json()["revision"] == 2


async def test_the_device_clock_never_decides(c: AsyncClient) -> None:
    """D11: ``X-Client-Time`` is ignored; the later *arrival* wins whatever the clocks say."""
    task = await new_task(c)
    await c.patch(
        f"/api/tasks/{task['id']}",
        json={"base_revision": 1, "priority": "high"},
        headers=h(c) | {"X-Client-Time": "9999999999999"},
    )
    r = await c.patch(
        f"/api/tasks/{task['id']}",
        json={"base_revision": 1, "priority": "low"},
        headers=h(c) | {"X-Client-Time": "1"},
    )
    assert r.json()["priority"] == "low", "the older clock still wins when it arrives later"


# --- edit versus delete (03d) -------------------------------------------------------------------


async def test_an_edit_of_a_deleted_task_brings_it_back(c: AsyncClient) -> None:
    task = await new_task(c)
    d = await c.delete(f"/api/tasks/{task['id']}", params={"base_revision": 1}, headers=h(c))
    assert d.status_code == 204
    r = await patch(c, task, title="edited elsewhere")
    out = r.json()
    assert r.status_code == 200 and out["title"] == "edited elsewhere" and out["revision"] == 3
    assert [x["rule"] for x in out["sync"]["resolution"]] == ["edit_wins_over_delete"]
    assert (await get(c, "tasks", task["id"])).status_code == 200


async def test_without_sync_mode_an_edit_of_a_deleted_task_is_still_404(c: AsyncClient) -> None:
    task = await new_task(c)
    await c.delete(f"/api/tasks/{task['id']}", headers=csrf_headers(c))
    r = await c.patch(f"/api/tasks/{task['id']}", json={"title": "x"}, headers=csrf_headers(c))
    assert r.status_code == 404


async def test_a_stale_delete_loses_to_the_edit(c: AsyncClient) -> None:
    task = await new_task(c)
    await patch(c, task, title="edited")
    r = await c.delete(f"/api/tasks/{task['id']}", params={"base_revision": 1}, headers=h(c))
    assert r.status_code == 409
    body = r.json()
    assert body["error"] == "edit_wins" and body["current_revision"] == 2
    assert (
        body["entity"]["title"] == "edited"
        and body["resolution"][0]["rule"] == "edit_wins_over_delete"
    )
    assert (await get(c, "tasks", task["id"])).status_code == 200
    ok = await c.delete(f"/api/tasks/{task['id']}", params={"base_revision": 2}, headers=h(c))
    assert ok.status_code == 204
    again = await c.delete(f"/api/tasks/{task['id']}", params={"base_revision": 2}, headers=h(c))
    assert again.status_code == 204, "deleting a deleted task is an idempotent no-op"


async def test_reviving_edit_into_a_deleted_project_unfiles_the_task(c: AsyncClient) -> None:
    project = (await c.post("/api/projects", json={"name": "p"}, headers=h(c))).json()
    task = await new_task(c, project_id=project["id"])
    await c.delete(f"/api/tasks/{task['id']}", params={"base_revision": 1}, headers=h(c))
    await c.delete(f"/api/projects/{project['id']}", params={"base_revision": 1}, headers=h(c))
    r = await patch(c, task, title="back")
    assert r.status_code == 200 and r.json()["project_id"] is None


async def test_a_deleted_parent_promotes_children_and_a_late_edit_still_merges(
    c: AsyncClient,
) -> None:
    parent = await new_task(c)
    child = await new_task(c, parent_task_id=parent["id"])
    await c.delete(f"/api/tasks/{parent['id']}", params={"base_revision": 1}, headers=h(c))
    r = await patch(c, child, title="renamed")  # based on the child's revision 1
    out = r.json()
    assert r.status_code == 200 and out["title"] == "renamed" and out["parent_task_id"] is None


# --- projects -----------------------------------------------------------------------------------


async def test_project_merge_conflict_and_revive(c: AsyncClient) -> None:
    project = (await c.post("/api/projects", json={"name": "p"}, headers=h(c))).json()

    async def pp(base: int, **body: Any) -> Response:
        return await c.patch(
            f"/api/projects/{project['id']}",
            json={"base_revision": base, **body},
            headers=h(c),
        )

    assert (await pp(1, name="A")).status_code == 200
    merged = await pp(1, status="completed")
    assert merged.status_code == 200 and merged.json()["name"] == "A"
    clash = await pp(1, name="B")
    assert clash.status_code == 409 and clash.json()["conflicts"][0]["server_value"] == "A"
    lww = await pp(1, status="archived")
    assert lww.json()["sync"]["resolution"][0]["loser"] == "completed"
    stale_delete = await c.delete(
        f"/api/projects/{project['id']}", params={"base_revision": 1}, headers=h(c)
    )
    assert stale_delete.status_code == 409 and stale_delete.json()["error"] == "edit_wins"
    current = (await get(c, "projects", project["id"])).json()["revision"]
    await c.delete(
        f"/api/projects/{project['id']}", params={"base_revision": current}, headers=h(c)
    )
    revived = await pp(current, description="back")
    assert revived.status_code == 200 and revived.json()["sync"]["resolution"][0]["rule"] == (
        "edit_wins_over_delete"
    )
