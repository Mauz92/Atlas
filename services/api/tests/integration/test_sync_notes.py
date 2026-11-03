"""Sync-mode note creates and writes: client ids, live-path uniqueness, collisions (SYNC-03c).

Note history, three-way merge and edit-wins for notes are SYNC-04; here a sync-mode note write
needs an idempotency key and (for update/delete/move) a base revision, and a create may carry a
client id.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from httpx import AsyncClient

from atlas.notes import NotesStorage
from tests.conftest import create_user_via_setup, csrf_headers

pytestmark = pytest.mark.usefixtures("_db")


@pytest.fixture
async def c(notes_client: AsyncClient) -> AsyncClient:
    await create_user_via_setup(notes_client)
    return notes_client


def h(c: AsyncClient, key: str | None = None) -> dict[str, str]:
    return {"Atlas-Sync": "1", "Idempotency-Key": key or str(uuid.uuid4()), **csrf_headers(c)}


async def create(c: AsyncClient, path: str, content: str = "# x\n", **extra: Any):
    return await c.post(
        "/api/notes", json={"path": path, "content": content, **extra}, headers=h(c)
    )


async def test_a_client_id_is_used_and_replays(c: AsyncClient) -> None:
    cid = str(uuid.uuid4())
    a = await create(c, "a.md", "one", id=cid)
    assert a.status_code == 201 and a.json()["id"] == cid and a.json()["sync"]["revision"] == 1
    b = await create(c, "a.md", "one", id=cid)  # new key, same id and body
    assert b.status_code == 201 and b.json()["id"] == cid
    assert b.headers["Idempotency-Replayed"] == "true"
    assert len((await c.get("/api/notes")).json()["notes"]) == 1


async def test_the_same_key_replays_a_summary_without_the_content(c: AsyncClient) -> None:
    key = str(uuid.uuid4())
    a = await c.post("/api/notes", json={"path": "k.md", "content": "body"}, headers=h(c, key))
    b = await c.post("/api/notes", json={"path": "k.md", "content": "body"}, headers=h(c, key))
    assert b.status_code == 201 and b.headers["Idempotency-Replayed"] == "true"
    assert b.json()["id"] == a.json()["id"] and "content" not in b.json()
    mismatch = await c.post("/api/notes", json={"path": "k.md", "content": "x"}, headers=h(c, key))
    assert mismatch.status_code == 409 and mismatch.json()["error"] == "idempotency_mismatch"
    assert len((await c.get("/api/notes")).json()["notes"]) == 1


async def test_a_taken_id_with_another_body_is_409(c: AsyncClient) -> None:
    cid = str(uuid.uuid4())
    await create(c, "a.md", "one", id=cid)
    for path, content in (("a.md", "two"), ("b.md", "one")):
        r = await create(c, path, content, id=cid)
        assert r.status_code == 409 and r.json()["error"] == "id_exists"


async def test_a_taken_path_becomes_a_numbered_copy_in_sync_mode(c: AsyncClient) -> None:
    await create(c, "dup.md", "first")
    r = await create(c, "dup.md", "second")
    assert r.status_code == 201 and r.json()["path"] == "dup (2).md"
    (res,) = r.json()["sync"]["resolution"]
    assert res["rule"] == "path_collision" and "dup.md" in res["detail"]
    assert (await create(c, "dup.md", "third")).json()["path"] == "dup (3).md"


async def test_without_sync_mode_a_taken_path_is_still_a_conflict(c: AsyncClient) -> None:
    plain = csrf_headers(c)
    await c.post("/api/notes", json={"path": "p.md", "content": "x"}, headers=plain)
    r = await c.post("/api/notes", json={"path": "p.md", "content": "y"}, headers=plain)
    assert r.status_code == 409


async def test_a_collision_retry_with_the_same_id_is_recognised(c: AsyncClient) -> None:
    await create(c, "dup.md", "first")
    cid = str(uuid.uuid4())
    a = await create(c, "dup.md", "second", id=cid)
    b = await create(c, "dup.md", "second", id=cid)
    assert a.json()["path"] == b.json()["path"] == "dup (2).md" and b.status_code == 201


async def test_a_new_note_can_take_the_path_of_a_deleted_one(c: AsyncClient) -> None:
    old = (await create(c, "reuse.md", "old")).json()
    d = await c.delete(f"/api/notes/{old['id']}", params={"base_revision": 1}, headers=h(c))
    assert d.status_code == 204
    cid = str(uuid.uuid4())
    new = await create(c, "reuse.md", "new", id=cid)
    assert new.status_code == 201 and new.json()["id"] == cid and new.json()["path"] == "reuse.md"
    assert (await c.get(f"/api/notes/{old['id']}")).status_code == 404, "the old note stays deleted"
    live = (await c.get("/api/notes")).json()["notes"]
    assert [n["id"] for n in live] == [cid]


async def test_without_a_client_id_a_deleted_note_is_revived_as_before(c: AsyncClient) -> None:
    old = (await create(c, "back.md", "old")).json()
    await c.delete(f"/api/notes/{old['id']}", params={"base_revision": 1}, headers=h(c))
    again = await create(c, "back.md", "again")
    assert again.json()["id"] == old["id"], "today's behaviour (task links survive)"


async def test_sync_mode_note_writes_need_a_key_and_a_base(c: AsyncClient) -> None:
    note = (await create(c, "w.md", "x")).json()
    headers = {"Atlas-Sync": "1", **csrf_headers(c)}
    r = await c.put(
        f"/api/notes/{note['id']}", json={"content": "y", "base_revision": 1}, headers=headers
    )
    assert r.status_code == 422 and r.json()["error"] == "idempotency_key_required"
    r = await c.post(f"/api/notes/{note['id']}/move", json={"path": "z.md"}, headers=h(c))
    assert r.status_code == 422 and r.json()["error"] == "base_revision_required"
    r = await c.delete(f"/api/notes/{note['id']}", headers=h(c))
    assert r.status_code == 422 and r.json()["error"] == "base_revision_required"
    r = await c.put(
        f"/api/notes/{note['id']}",
        json={"content": "y", "base_revision": 1, "nope": 1},
        headers=h(c),
    )
    assert r.status_code == 422 and r.json()["error"] == "unknown_fields"


async def test_a_retried_note_update_applies_once(c: AsyncClient) -> None:
    note = (await create(c, "u.md", "x")).json()
    key = str(uuid.uuid4())
    body = {"content": "y", "base_revision": 1}
    a = await c.put(f"/api/notes/{note['id']}", json=body, headers=h(c, key))
    b = await c.put(f"/api/notes/{note['id']}", json=body, headers=h(c, key))
    assert a.status_code == b.status_code == 200
    assert b.headers["Idempotency-Replayed"] == "true" and b.json()["revision"] == 2
    assert (await c.get(f"/api/notes/{note['id']}")).json()["revision"] == 2
    stale = await c.put(f"/api/notes/{note['id']}", json=body, headers=h(c))
    assert stale.status_code == 409 and stale.json()["error"] == "stale"


async def test_note_writes_without_sync_mode_ignore_keys_as_before(
    c: AsyncClient, notes_storage: NotesStorage
) -> None:
    plain = {**csrf_headers(c), "Idempotency-Key": "k"}
    a = await c.post("/api/notes", json={"path": "n.md", "content": "x"}, headers=plain)
    assert a.status_code == 201 and a.json()["sync"] is None
    again = await c.post("/api/notes", json={"path": "n.md", "content": "x"}, headers=plain)
    assert again.status_code == 409, "no key support outside sync mode: unchanged"


async def test_reconcile_and_folder_rename_ignore_a_tombstone_sharing_a_live_path(
    c: AsyncClient,
) -> None:
    old = (await create(c, "dir/n.md", "old")).json()
    await c.delete(f"/api/notes/{old['id']}", params={"base_revision": 1}, headers=h(c))
    cid = str(uuid.uuid4())
    await create(c, "dir/n.md", "new", id=cid)
    r = await c.post("/api/notes/reconcile", headers=csrf_headers(c))
    assert r.status_code == 200 and r.json()["updated"] == 0 and r.json()["added"] == 0
    moved = await c.post(
        "/api/folders/rename",
        json={"path": "dir", "new_path": "other"},
        headers=csrf_headers(c),
    )
    assert moved.status_code == 200 and moved.json()["moved_notes"] == 1
    live = (await c.get("/api/notes")).json()["notes"]
    assert [(n["id"], n["path"]) for n in live] == [(cid, "other/n.md")]
    assert (await c.get(f"/api/notes/{old['id']}")).status_code == 404
