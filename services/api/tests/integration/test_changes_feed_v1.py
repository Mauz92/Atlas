"""Feed additions of protocol v1 (SYNC-03e): snapshot, ``types=``, ``include=data``, head/floor."""

from __future__ import annotations

import uuid

import pytest
from httpx import AsyncClient

from tests.conftest import create_user_via_setup, csrf_headers

pytestmark = pytest.mark.usefixtures("_db")


@pytest.fixture
async def c(notes_client: AsyncClient) -> AsyncClient:
    await create_user_via_setup(notes_client)
    return notes_client


async def task(c: AsyncClient, title: str = "t", **body: object) -> dict:
    r = await c.post("/api/tasks", json={"title": title, **body}, headers=csrf_headers(c))
    assert r.status_code == 201, r.text
    return r.json()


async def pull(c: AsyncClient, **params: object) -> dict:
    r = await c.get("/api/changes", params={k: v for k, v in params.items() if v is not None})
    assert r.status_code == 200, r.text
    return r.json()


async def walk(c: AsyncClient, **params: object) -> list[dict]:
    items: list[dict] = []
    since = 0
    for _ in range(50):
        page = await pull(c, since=since, **params)
        items.extend(page["changes"])
        since = page["next_since"]
        if not page["has_more"]:
            return items
    raise AssertionError("did not terminate")


async def test_since_zero_is_a_snapshot_without_tombstones(c: AsyncClient) -> None:
    a, b, d = await task(c, "a"), await task(c, "b"), await task(c, "d")
    await c.delete(f"/api/tasks/{b['id']}", headers=csrf_headers(c))
    page = await pull(c, since=0)
    assert {i["entity_id"] for i in page["changes"]} == {a["id"], d["id"]}
    assert all(i["operation"] == "upsert" for i in page["changes"])
    # Walking in small pages: every live entity arrives as an upsert, the deleted one never does.
    # (Only the *first* page leaves tombstones out; a later page may carry one, which a client
    # with no copy of that entity ignores.)
    items = await walk(c, limit=1)
    upserts = {i["entity_id"] for i in items if i["operation"] == "upsert"}
    assert upserts == {a["id"], d["id"]}


async def test_a_deletion_during_the_walk_is_delivered_by_a_later_page(c: AsyncClient) -> None:
    a, b = await task(c, "a"), await task(c, "b")
    first = await pull(c, since=0, limit=1)
    assert [i["entity_id"] for i in first["changes"]] == [a["id"]] and first["has_more"]
    await c.delete(f"/api/tasks/{b['id']}", headers=csrf_headers(c))  # b not yet delivered
    rest = await pull(c, since=first["next_since"], limit=5)
    assert [(i["entity_id"], i["operation"]) for i in rest["changes"]] == [(b["id"], "delete")]


async def test_the_last_page_reports_the_head_so_the_cursor_moves_past_filtered_rows(
    c: AsyncClient,
) -> None:
    project = (
        await c.post("/api/projects", json={"name": "p"}, headers=csrf_headers(c))
    ).json()  # cursor 1
    await task(c, "x")  # 2
    await task(c, "y")  # 3
    page = await pull(c, since=0, types="project")
    assert [i["entity_id"] for i in page["changes"]] == [project["id"]]
    assert page["has_more"] is False and page["next_since"] == 3 == page["head"]
    only_tasks = await walk(c, types="task", limit=1)
    assert [i["entity_type"] for i in only_tasks] == ["task", "task"]
    # nothing but filtered-out rows after the cursor: no items, but the cursor still moves
    empty = await pull(c, since=1, types="project")
    assert empty["changes"] == [] and empty["next_since"] == 3


async def test_types_accepts_a_list_and_rejects_unknown_names(c: AsyncClient) -> None:
    await task(c)
    both = await pull(c, types="task,project")
    assert len(both["changes"]) == 1
    bad = await c.get("/api/changes", params={"types": "task,widget"})
    assert bad.status_code == 422 and "widget" in bad.text


async def test_include_data_carries_the_stored_state(c: AsyncClient) -> None:
    t = await task(c, "with data", tags=["a", "b"], priority="high")
    p = (await c.post("/api/projects", json={"name": "proj"}, headers=csrf_headers(c))).json()
    n = (
        await c.post(
            "/api/notes",
            json={"path": "n.md", "content": "# Heading\n\nsecret body\n"},
            headers=csrf_headers(c),
        )
    ).json()
    await c.put(f"/api/projects/{p['id']}/notes/{n['id']}", headers=csrf_headers(c))
    page = await pull(c, since=0, include="data")
    by_id = {i["entity_id"]: i for i in page["changes"]}
    task_item = by_id[t["id"]]
    assert task_item["revision"] == 1
    data = task_item["data"]
    assert data["title"] == "with data" and data["priority"] == "high"
    assert data["tags"] == ["a", "b"] and data["field_revisions"]["title"] == 1
    assert data["deleted_at"] is None
    assert "due_state" not in data and "subtasks_total" not in data, "derived values are not synced"
    assert by_id[p["id"]]["data"]["name"] == "proj" and "progress" not in by_id[p["id"]]["data"]
    note_data = by_id[n["id"]]["data"]
    assert note_data["path"] == "n.md" and note_data["content_hash"] == n["content_hash"]
    assert "content" not in note_data and "secret body" not in str(note_data)
    link = next(i for i in page["changes"] if i["entity_type"] == "note_project_link")
    assert link["data"] is None and link["revision"] is None


async def test_a_tombstone_carries_deleted_at_and_data_is_current(c: AsyncClient) -> None:
    t = await task(c)
    first = await pull(c, since=0, include="data")
    await c.patch(f"/api/tasks/{t['id']}", json={"title": "newer"}, headers=csrf_headers(c))
    await c.delete(f"/api/tasks/{t['id']}", headers=csrf_headers(c))
    after = await pull(c, since=first["next_since"], include="data")
    (item,) = after["changes"]
    assert item["operation"] == "delete" and item["data"]["deleted_at"] is not None
    assert item["data"]["title"] == "newer" and item["revision"] == 3


async def test_data_pages_are_capped_at_200_and_plain_pages_at_500(c: AsyncClient) -> None:
    assert (
        await c.get("/api/changes", params={"include": "data", "limit": 201})
    ).status_code == 422
    assert (
        await c.get("/api/changes", params={"include": "data", "limit": 200})
    ).status_code == 200
    assert (await c.get("/api/changes", params={"limit": 500})).status_code == 200
    assert (await c.get("/api/changes", params={"limit": 501})).status_code == 422
    assert (await c.get("/api/changes", params={"include": "everything"})).status_code == 422


async def test_head_and_floor_are_reported(c: AsyncClient) -> None:
    await task(c)
    page = await pull(c)
    assert page["head"] == 1 and page["floor"] == 0


async def test_sync_mode_reads_the_same_feed(c: AsyncClient) -> None:
    await task(c)
    r = await c.get("/api/changes", headers={"Atlas-Sync": "1"}, params={"include": "data"})
    assert r.status_code == 200 and r.json()["changes"][0]["data"]["title"] == "t"


async def test_the_data_of_a_task_created_with_a_client_id_is_under_that_id(c: AsyncClient) -> None:
    cid = str(uuid.uuid4())
    await task(c, id=cid)
    page = await pull(c, include="data")
    assert page["changes"][0]["entity_id"] == cid and page["changes"][0]["data"]["id"] == cid


async def test_a_multi_page_bootstrap_survives_a_floor_above_its_position(c: AsyncClient) -> None:
    """Regression (sim seed 29): without ``snapshot=true`` page 2 of a walk was ``below_floor``."""
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import update

    from atlas.changes import ChangePurgeService
    from atlas.db import session_scope
    from atlas.models import ChangeLog

    ids = [(await task(c, f"t{n}"))["id"] for n in range(5)]  # cursors 1..5
    doomed = await task(c, "doomed")  # cursor 6
    await c.delete(f"/api/tasks/{doomed['id']}", headers=csrf_headers(c))  # tombstone, cursor 7
    async with session_scope() as session:
        await session.execute(
            update(ChangeLog)
            .where(ChangeLog.entity_id == doomed["id"])
            .values(changed_at=datetime.now(UTC) - timedelta(days=400))
        )
    async with session_scope() as session:
        await ChangePurgeService(session).purge(cutoff=datetime.now(UTC) - timedelta(days=90))

    first = await pull(c, since=0, limit=2)
    assert first["floor"] == 7 and first["has_more"] and first["next_since"] == 2
    plain = await pull(c, since=first["next_since"], limit=2)
    assert plain["resync_required"] is True and plain["resync_reason"] == "below_floor"
    seen = [i["entity_id"] for i in first["changes"]]
    since = first["next_since"]
    for _ in range(10):
        page = await pull(c, since=since, limit=2, snapshot="true")
        assert page["resync_required"] is False
        seen += [i["entity_id"] for i in page["changes"]]
        since = page["next_since"]
        if not page["has_more"]:
            break
    assert sorted(seen) == sorted(ids) and since == page["head"]
