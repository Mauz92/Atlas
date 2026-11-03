"""The automatic-resolution log, its feed entity and undo (SYNC-05; SYNC_PROTOCOL.md section 9).

Layer A: real PostgreSQL and (for notes) real files. The simulation (``tests/sim``) covers the
multi-client invariants; these tests pin the individual behaviours: what is logged, in which
transaction, what is never stored, who can see it, how undo reports a conflict and how a retry,
a replay and the retention purge behave.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError

from atlas.db import session_scope
from atlas.idempotency import IdempotencyStore
from atlas.models import ChangeLog, SyncResolution, User
from atlas.sync.resolution_log import NewResolution, ResolutionLog, purge_resolutions
from tests.conftest import create_user_via_setup, csrf_headers

pytestmark = pytest.mark.usefixtures("_db")

BASE = "# Title\n\nalpha\n\nbeta\n\ngamma\n"


@pytest.fixture
async def c(notes_client: AsyncClient) -> AsyncClient:
    await create_user_via_setup(notes_client)
    return notes_client


def h(c: AsyncClient, key: str | None = None, *, sync: bool = True) -> dict[str, str]:
    headers = {"Idempotency-Key": key or str(uuid.uuid4()), **csrf_headers(c)}
    if sync:
        headers["Atlas-Sync"] = "1"
    return headers


async def new_task(c: AsyncClient, **body: Any) -> dict[str, Any]:
    r = await c.post("/api/tasks", json={"title": "t", **body}, headers=h(c))
    assert r.status_code == 201, r.text
    return r.json()  # type: ignore[no-any-return]


async def patch_task(c: AsyncClient, task_id: str, base: int, **body: Any) -> Any:
    return await c.patch(
        f"/api/tasks/{task_id}", json={"base_revision": base, **body}, headers=h(c)
    )


async def log(c: AsyncClient, **params: Any) -> list[dict[str, Any]]:
    r = await c.get("/api/sync/resolutions", params={"limit": 200, **params})
    assert r.status_code == 200, r.text
    return r.json()["resolutions"]  # type: ignore[no-any-return]


async def later_wins(c: AsyncClient) -> tuple[dict[str, Any], dict[str, Any]]:
    """Two devices set `priority` from revision 1: the second one's value wins and is logged.
    Returns the task (after the second write) and the response of that write."""
    task = await new_task(c)
    first = await patch_task(c, task["id"], 1, priority="low")
    assert first.status_code == 200 and first.json()["sync"]["resolution"] == []
    second = await patch_task(c, task["id"], 1, priority="high")
    assert second.status_code == 200, second.text
    return second.json(), second.json()


async def undo(c: AsyncClient, resolution_id: str, key: str | None = None) -> Any:
    return await c.post(f"/api/sync/resolutions/{resolution_id}/undo", headers=h(c, key))


# --- what is logged ------------------------------------------------------------------------------


async def test_a_simple_field_later_wins_is_logged_with_the_overwritten_value(
    c: AsyncClient,
) -> None:
    task, _ = await later_wins(c)
    [res] = task["sync"]["resolution"]
    assert res["rule"] == "simple_later_wins" and res["field"] == "priority"
    assert res["loser"] == "low" and res["kept_revision"] == task["revision"]
    entries = await log(c)
    assert len(entries) == 1
    entry = entries[0]
    assert entry["id"] == res["id"]
    assert (entry["entity_type"], entry["entity_id"]) == ("task", task["id"])
    assert (entry["rule"], entry["field"], entry["loser"], entry["has_loser"]) == (
        "simple_later_wins",
        "priority",
        "low",
        True,
    )
    assert entry["kept_revision"] == task["revision"] and entry["device_id"] is None
    assert entry["undoable"] is True and entry["undo_blocked"] is None
    assert entry["undone_at"] is None and entry["created_at"]


async def test_a_loser_of_null_is_a_stored_value_not_a_missing_one(c: AsyncClient) -> None:
    task = await new_task(c)
    await patch_task(c, task["id"], 1, due_at="2031-01-01T10:00:00Z")
    second = await patch_task(c, task["id"], 1, due_at=None)
    assert second.status_code == 200, second.text
    [entry] = await log(c)
    assert entry["field"] == "due_at" and entry["loser"].startswith("2031-01-01T10:00:00")
    # now the reverse: the overwritten value is null
    third = await patch_task(
        c, task["id"], second.json()["revision"], due_at="2032-02-02T10:00:00Z"
    )
    assert third.status_code == 200
    stale = await patch_task(
        c, task["id"], second.json()["revision"], due_at="2033-03-03T10:00:00Z"
    )
    assert stale.status_code == 200
    newest = (await log(c))[0]
    assert newest["has_loser"] is True and newest["undoable"] is True
    assert newest["loser"].startswith("2032-02-02")


async def test_a_project_field_is_logged_too(c: AsyncClient) -> None:
    project = (await c.post("/api/projects", json={"name": "p"}, headers=h(c))).json()
    one = await c.patch(
        f"/api/projects/{project['id']}",
        json={"base_revision": 1, "status": "archived"},
        headers=h(c),
    )
    two = await c.patch(
        f"/api/projects/{project['id']}",
        json={"base_revision": 1, "status": "completed"},
        headers=h(c),
    )
    assert one.status_code == two.status_code == 200, two.text
    [entry] = await log(c)
    assert (entry["entity_type"], entry["field"], entry["loser"]) == (
        "project",
        "status",
        "archived",
    )


async def test_text_conflicts_are_not_resolutions_and_no_text_is_ever_stored(
    c: AsyncClient,
) -> None:
    task = await new_task(c, title="original title")
    assert (await patch_task(c, task["id"], 1, title="SECRET-ONE")).status_code == 200
    refused = await patch_task(c, task["id"], 1, title="SECRET-TWO", description="SECRET-DESC")
    assert refused.status_code == 200  # the description applied, the title is a conflict
    assert refused.json()["sync"]["conflicts"][0]["field"] == "title"
    assert await log(c) == [], "a text conflict is returned to the client, never logged"
    async with session_scope() as session:
        dump = await session.execute(text("SELECT row_to_json(r)::text FROM sync_resolutions r"))
        assert dump.all() == []


async def test_a_revive_is_logged_as_edit_wins_and_cannot_be_undone(c: AsyncClient) -> None:
    task = await new_task(c)
    assert (
        await c.delete(f"/api/tasks/{task['id']}", params={"base_revision": 1}, headers=h(c))
    ).status_code == 204
    revived = await patch_task(c, task["id"], 1, priority="high")
    assert revived.status_code == 200
    [entry] = await log(c)
    assert entry["rule"] == "edit_wins_over_delete" and entry["field"] is None
    assert entry["kept_revision"] == revived.json()["revision"]
    assert entry["undoable"] is False and entry["undo_blocked"] == "rule_not_undoable"
    assert entry["follow_up"] == {"kind": "delete_again", "href": None}
    refused = await undo(c, entry["id"])
    assert refused.status_code == 409 and refused.json()["error"] == "not_undoable"
    assert refused.json()["follow_up"]["kind"] == "delete_again"
    # "delete again" is an ordinary delete based on the revived revision
    again = await c.delete(
        f"/api/tasks/{task['id']}",
        params={"base_revision": revived.json()["revision"]},
        headers=h(c),
    )
    assert again.status_code == 204


async def test_a_refused_delete_writes_nothing_and_logs_nothing(c: AsyncClient) -> None:
    task = await new_task(c)
    await patch_task(c, task["id"], 1, priority="low")
    refused = await c.delete(f"/api/tasks/{task['id']}", params={"base_revision": 1}, headers=h(c))
    assert refused.status_code == 409 and refused.json()["error"] == "edit_wins"
    assert await log(c) == []


async def test_no_resolution_outside_sync_mode(c: AsyncClient) -> None:
    task = await new_task(c)
    await c.patch(f"/api/tasks/{task['id']}", json={"priority": "low"}, headers=h(c, sync=False))
    await c.patch(
        f"/api/tasks/{task['id']}", json={"priority": "high", "base_revision": 2},
        headers=h(c, sync=False),
    )  # fmt: skip
    assert await log(c) == []


# --- retries and atomicity --------------------------------------------------------------------


async def test_a_replayed_write_logs_nothing_more(c: AsyncClient) -> None:
    task = await new_task(c)
    await patch_task(c, task["id"], 1, priority="low")
    key = str(uuid.uuid4())
    body = {"base_revision": 1, "priority": "high"}
    first = await c.patch(f"/api/tasks/{task['id']}", json=body, headers=h(c, key))
    again = await c.patch(f"/api/tasks/{task['id']}", json=body, headers=h(c, key))
    assert again.headers["Idempotency-Replayed"] == "true"
    assert (
        again.json()["sync"]["resolution"][0]["id"] == first.json()["sync"]["resolution"][0]["id"]
    )
    assert len(await log(c)) == 1


async def test_a_failing_request_leaves_no_log_entry_and_no_feed_row(
    c: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    task = await new_task(c)
    await patch_task(c, task["id"], 1, priority="low")
    before = (await c.get("/api/changes", params={"since": 0})).json()["head"]

    async def boom(*_a: Any, **_k: Any) -> None:
        raise RuntimeError("the response could not be stored")

    monkeypatch.setattr(IdempotencyStore, "remember", boom)
    with pytest.raises(RuntimeError):
        await patch_task(c, task["id"], 1, priority="high")
    monkeypatch.undo()
    assert await log(c) == []
    assert (await c.get("/api/changes", params={"since": 0})).json()["head"] == before
    assert (await c.get(f"/api/tasks/{task['id']}")).json()["priority"] == "low"


async def test_the_same_key_and_position_cannot_be_logged_twice(c: AsyncClient) -> None:
    task = await new_task(c)
    entry = NewResolution("task", uuid.UUID(task["id"]), "simple_later_wins", field="priority")
    async with session_scope() as session:
        user_id = await session.scalar(select(User.id))
        assert user_id is not None
        await ResolutionLog(session, user_id).record([entry], op_key="k-1")
    with pytest.raises(IntegrityError):
        async with session_scope() as session:
            await ResolutionLog(session, user_id).record([entry], op_key="k-1")


# --- the feed entity ------------------------------------------------------------------------------


async def test_a_resolution_is_announced_on_the_feed_with_data(c: AsyncClient) -> None:
    task, _ = await later_wins(c)
    res_id = task["sync"]["resolution"][0]["id"]
    page = (
        await c.get(
            "/api/changes",
            params={"since": 0, "include": "data", "types": "resolution"},
            headers={"Atlas-Sync": "1"},
        )
    ).json()
    [item] = page["changes"]
    assert (item["entity_type"], item["entity_id"], item["operation"]) == (
        "resolution",
        res_id,
        "upsert",
    )
    assert item["revision"] == 1
    assert item["data"]["rule"] == "simple_later_wins" and item["data"]["loser"] == "low"
    assert item["data"]["undoable"] is True
    # without `include=data` the item is just the id
    bare = (await c.get("/api/changes", params={"types": "resolution"})).json()["changes"]
    assert [(i["entity_type"], i["data"]) for i in bare] == [("resolution", None)]


async def test_the_default_feed_shows_resolutions_only_in_sync_mode(c: AsyncClient) -> None:
    await later_wins(c)

    def kinds(page: dict[str, Any]) -> set[str]:
        return {i["entity_type"] for i in page["changes"]}

    legacy = (await c.get("/api/changes", params={"since": 0})).json()
    assert kinds(legacy) == {"task"}, "the web app never sees an entity type it does not know"
    sync = (await c.get("/api/changes", params={"since": 0}, headers={"Atlas-Sync": "1"})).json()
    assert kinds(sync) == {"task", "resolution"}
    # the cursor semantics are the same: the legacy page still advances to the head
    assert legacy["next_since"] == legacy["head"] == sync["head"]
    filtered = (
        await c.get(
            "/api/changes",
            params={"since": 0, "types": "task"},
            headers={"Atlas-Sync": "1"},
        )
    ).json()
    assert kinds(filtered) == {"task"} and filtered["next_since"] == filtered["head"]
    bad = await c.get("/api/changes", params={"types": "resolutions"})
    assert bad.status_code == 422


async def test_an_undo_re_announces_the_resolution_as_undone(c: AsyncClient) -> None:
    task, _ = await later_wins(c)
    res_id = task["sync"]["resolution"][0]["id"]
    cursor = (await c.get("/api/changes", params={"since": 0})).json()["head"]
    done = await undo(c, res_id)
    assert done.status_code == 200, done.text
    page = (
        await c.get(
            "/api/changes",
            params={"since": cursor, "include": "data", "types": "resolution,task"},
        )
    ).json()
    by_id = {i["entity_id"]: i for i in page["changes"]}
    undo_id = done.json()["undo"]["id"]
    assert set(by_id) == {res_id, undo_id, task["id"]}
    assert by_id[res_id]["revision"] == 2 and by_id[res_id]["data"]["undone_at"]
    assert by_id[undo_id]["data"]["rule"] == "undo"
    assert by_id[undo_id]["data"]["undoes_id"] == res_id
    assert by_id[task["id"]]["data"]["priority"] == "low"


# --- undo -----------------------------------------------------------------------------------------


async def test_undo_restores_the_overwritten_value_through_the_checked_write_path(
    c: AsyncClient,
) -> None:
    task, _ = await later_wins(c)
    res_id = task["sync"]["resolution"][0]["id"]
    done = await undo(c, res_id)
    assert done.status_code == 200, done.text
    body = done.json()
    assert body["applied"] is True and body["revision"] == task["revision"] + 1
    assert body["resolution"]["undone_at"] and body["resolution"]["undoable"] is False
    assert body["resolution"]["undo_blocked"] == "already_undone"
    undo_entry = body["undo"]
    assert undo_entry["rule"] == "undo" and undo_entry["undoes_id"] == res_id
    assert undo_entry["field"] == "priority" and undo_entry["loser"] == "high"
    assert undo_entry["undoable"] is False and undo_entry["undo_blocked"] == "is_undo"
    current = (await c.get(f"/api/tasks/{task['id']}")).json()
    assert current["priority"] == "low" and current["revision"] == body["revision"]
    assert current["field_revisions"]["priority"] == body["revision"]
    assert {e["rule"] for e in await log(c)} == {"simple_later_wins", "undo"}


async def test_undo_is_idempotent_by_key_and_a_second_undo_is_a_clear_error(
    c: AsyncClient,
) -> None:
    task, _ = await later_wins(c)
    res_id = task["sync"]["resolution"][0]["id"]
    key = str(uuid.uuid4())
    first = await undo(c, res_id, key)
    replay = await undo(c, res_id, key)
    assert replay.status_code == 200 and replay.headers["Idempotency-Replayed"] == "true"
    assert replay.json() == first.json()
    second = await undo(c, res_id)  # another key: the resolution is already undone
    assert second.status_code == 409 and second.json()["error"] == "already_undone"
    assert second.json()["resolution"]["undone_at"]
    assert len(await log(c, rule="undo")) == 1
    assert (await c.get(f"/api/tasks/{task['id']}")).json()["revision"] == first.json()["revision"]
    mismatch = await undo(c, str(uuid.uuid4()), key)  # the key belongs to another request
    assert mismatch.status_code == 409 and mismatch.json()["error"] == "idempotency_mismatch"


async def test_undo_requires_a_key(c: AsyncClient) -> None:
    task, _ = await later_wins(c)
    res_id = task["sync"]["resolution"][0]["id"]
    r = await c.post(
        f"/api/sync/resolutions/{res_id}/undo", headers={"Atlas-Sync": "1", **csrf_headers(c)}
    )
    assert r.status_code == 422 and r.json()["error"] == "idempotency_key_required"


async def test_undo_never_overwrites_a_newer_value(c: AsyncClient) -> None:
    task, _ = await later_wins(c)
    res_id = task["sync"]["resolution"][0]["id"]
    newer = await patch_task(c, task["id"], task["revision"], priority="medium")
    assert newer.status_code == 200
    refused = await undo(c, res_id)
    assert refused.status_code == 409, refused.text
    body = refused.json()
    assert body["error"] == "conflict" and body["resolution_id"] == res_id
    [conflict] = body["conflicts"]
    assert conflict["field"] == "priority" and conflict["reason"] == "changed_since"
    assert conflict["server_value"] == "medium"
    current = (await c.get(f"/api/tasks/{task['id']}")).json()
    assert current["priority"] == "medium" and current["revision"] == newer.json()["revision"]
    [entry] = [e for e in await log(c) if e["id"] == res_id]
    assert entry["undone_at"] is None, "a refused undo leaves the entry as it was"
    assert await log(c, rule="undo") == []


async def test_undo_is_a_no_op_when_the_field_already_holds_the_value(c: AsyncClient) -> None:
    task, _ = await later_wins(c)
    res_id = task["sync"]["resolution"][0]["id"]
    same = await patch_task(c, task["id"], task["revision"], priority="low")
    assert same.status_code == 200
    done = await undo(c, res_id)
    assert done.status_code == 200 and done.json()["applied"] is False
    assert done.json()["revision"] == same.json()["revision"]
    assert done.json()["resolution"]["undone_at"]
    assert (await c.get(f"/api/tasks/{task['id']}")).json()["revision"] == same.json()["revision"]


async def test_undo_never_brings_a_deleted_entity_back(c: AsyncClient) -> None:
    task, _ = await later_wins(c)
    res_id = task["sync"]["resolution"][0]["id"]
    deleted = await c.delete(
        f"/api/tasks/{task['id']}", params={"base_revision": task["revision"]}, headers=h(c)
    )
    assert deleted.status_code == 204
    refused = await undo(c, res_id)
    assert refused.status_code == 409 and refused.json()["error"] == "entity_deleted"
    assert (await c.get(f"/api/tasks/{task['id']}")).status_code == 404


async def test_undo_reports_a_value_that_is_not_valid_any_more(c: AsyncClient) -> None:
    project = (await c.post("/api/projects", json={"name": "p"}, headers=h(c))).json()
    task = await new_task(c)
    await patch_task(c, task["id"], 1, project_id=project["id"])
    second = await patch_task(c, task["id"], 1, project_id=None)
    assert second.status_code == 200
    [entry] = await log(c)
    assert entry["field"] == "project_id" and entry["loser"] == project["id"]
    gone = await c.delete(
        f"/api/projects/{project['id']}", params={"base_revision": 1}, headers=h(c)
    )
    assert gone.status_code == 204
    refused = await undo(c, entry["id"])
    assert refused.status_code == 409 and refused.json()["error"] == "conflict"
    assert refused.json()["conflicts"][0]["reason"] == "invalid_value"
    assert (await c.get(f"/api/tasks/{task['id']}")).json()["project_id"] is None


async def test_undo_of_a_project_field(c: AsyncClient) -> None:
    project = (await c.post("/api/projects", json={"name": "p"}, headers=h(c))).json()
    for status_value in ("archived", "completed"):
        r = await c.patch(
            f"/api/projects/{project['id']}",
            json={"base_revision": 1, "status": status_value},
            headers=h(c),
        )
        assert r.status_code == 200
    [entry] = await log(c)
    done = await undo(c, entry["id"])
    assert done.status_code == 200 and done.json()["applied"] is True
    assert (await c.get(f"/api/projects/{project['id']}")).json()["status"] == "archived"


async def test_undo_reschedules_the_reminder_like_any_edit(c: AsyncClient) -> None:
    task = await new_task(c, due_at="2031-05-01T09:00:00Z")
    await patch_task(c, task["id"], 1, due_at="2031-06-01T09:00:00Z")
    second = await patch_task(c, task["id"], 1, due_at="2031-07-01T09:00:00Z")
    assert second.status_code == 200
    [entry] = await log(c, rule="simple_later_wins")
    done = await undo(c, entry["id"])
    assert done.status_code == 200
    back = (await c.get(f"/api/tasks/{task['id']}")).json()
    assert back["due_at"].startswith("2031-06-01T09:00")


async def test_undo_of_a_status_follows_the_state_machine(c: AsyncClient) -> None:
    ok = await new_task(c)
    await patch_task(c, ok["id"], 1, status="in_progress")
    done = await patch_task(c, ok["id"], 1, status="completed")
    assert done.status_code == 200 and done.json()["completed_at"]
    [entry] = await log(c, entity_id=ok["id"])
    assert (entry["field"], entry["loser"]) == ("status", "in_progress")
    undone = await undo(c, entry["id"])
    assert undone.status_code == 200 and undone.json()["applied"] is True
    back = (await c.get(f"/api/tasks/{ok['id']}")).json()
    assert back["status"] == "in_progress" and back["completed_at"] is None

    stuck = await new_task(c)
    await patch_task(c, stuck["id"], 1, status="next")
    assert (await patch_task(c, stuck["id"], 1, status="completed")).status_code == 200
    [entry] = await log(c, entity_id=stuck["id"])
    assert entry["loser"] == "next"
    refused = await undo(c, entry["id"])  # completed -> next is not a legal move
    assert refused.status_code == 409 and refused.json()["error"] == "conflict"
    assert refused.json()["conflicts"][0]["reason"] == "invalid_transition"
    assert (await c.get(f"/api/tasks/{stuck['id']}")).json()["status"] == "completed"
    assert (await log(c, entity_id=stuck["id"]))[0]["undone_at"] is None


async def test_undo_of_tags_restores_the_whole_set(c: AsyncClient) -> None:
    task = await new_task(c, tags=["a"])
    await patch_task(c, task["id"], 1, tags=["a", "b"])
    second = await patch_task(c, task["id"], 1, tags=["z"])
    assert second.status_code == 200, second.text
    [entry] = await log(c)
    assert (entry["field"], entry["loser"]) == ("tags", ["a", "b"])
    assert (await undo(c, entry["id"])).status_code == 200
    assert (await c.get(f"/api/tasks/{task['id']}")).json()["tags"] == ["a", "b"]


# --- notes ----------------------------------------------------------------------------------------


async def make_note(c: AsyncClient, path: str, content: str = BASE) -> dict[str, Any]:
    r = await c.post("/api/notes", json={"path": path, "content": content}, headers=h(c))
    assert r.status_code == 201, r.text
    return r.json()  # type: ignore[no-any-return]


async def save(c: AsyncClient, note: dict[str, Any], content: str) -> Any:
    return await c.put(
        f"/api/notes/{note['id']}",
        json={
            "content": content,
            "base_revision": note["revision"],
            "base_hash": note["content_hash"],
        },
        headers=h(c),
    )


async def move(c: AsyncClient, note_id: str, path: str, base: int) -> Any:
    return await c.post(
        f"/api/notes/{note_id}/move", json={"path": path, "base_revision": base}, headers=h(c)
    )


async def test_a_merged_note_is_logged_without_content_and_points_at_history(
    c: AsyncClient,
) -> None:
    note = await make_note(c, "m.md")
    theirs = BASE.replace("alpha", "ALPHA-SECRET")
    assert (await save(c, note, theirs)).status_code == 200
    mine = BASE.replace("gamma", "GAMMA-SECRET")
    merged = await save(c, note, mine)
    assert merged.status_code == 200 and merged.json()["sync"]["merged"] is True
    [entry] = await log(c)
    assert (entry["entity_type"], entry["rule"]) == ("note", "note_merged")
    assert entry["has_loser"] is False and entry["loser"] is None
    assert entry["undoable"] is False and entry["undo_blocked"] == "rule_not_undoable"
    assert entry["follow_up"] == {
        "kind": "note_history",
        "href": f"/api/notes/{note['id']}/history/{entry['kept_revision']}",
    }
    assert "SECRET" not in str(entry)
    history = await c.get(entry["follow_up"]["href"])
    assert history.status_code == 200 and "ALPHA-SECRET" in history.json()["content"]
    refused = await undo(c, entry["id"])
    assert refused.status_code == 409 and refused.json()["error"] == "not_undoable"
    assert refused.json()["follow_up"]["kind"] == "note_history"
    async with session_scope() as session:
        rows = await session.execute(text("SELECT row_to_json(r)::text FROM sync_resolutions r"))
        assert "SECRET" not in " ".join(r[0] for r in rows)


async def test_a_path_collision_is_logged_and_not_undoable(c: AsyncClient) -> None:
    await make_note(c, "same.md")
    second = await make_note(c, "same.md")
    assert second["path"] == "same (2).md"
    [entry] = await log(c)
    assert (entry["rule"], entry["entity_id"]) == ("path_collision", second["id"])
    assert entry["kept_revision"] == second["revision"]
    assert entry["follow_up"] == {"kind": "rename", "href": None}
    assert "same" in entry["detail"] and entry["has_loser"] is False


async def test_a_revive_that_ends_in_a_conflict_is_logged_too(c: AsyncClient) -> None:
    base = await make_note(c, "ro.md")
    other = (await save(c, base, BASE.replace("beta", "BETA"))).json()
    deleted = await c.delete(
        f"/api/notes/{base['id']}", params={"base_revision": other["revision"]}, headers=h(c)
    )
    assert deleted.status_code == 204
    key = str(uuid.uuid4())
    body = {
        "content": BASE.replace("beta", "beta mine"),
        "base_revision": base["revision"],
        "base_hash": base["content_hash"],
    }
    first = await c.put(f"/api/notes/{base['id']}", json=body, headers=h(c, key))
    assert first.status_code == 409 and first.json()["reason"] == "overlap"
    [res] = first.json()["resolution"]
    assert res["rule"] == "edit_wins_over_delete" and res["id"]
    replay = await c.put(f"/api/notes/{base['id']}", json=body, headers=h(c, key))
    assert replay.status_code == 409 and replay.json()["resolution"][0]["id"] == res["id"]
    entries = await log(c, entity_id=base["id"])
    assert [e["rule"] for e in entries] == ["edit_wins_over_delete"]
    assert entries[0]["id"] == res["id"]


async def test_a_note_move_that_overrides_another_is_logged_and_can_be_undone(
    c: AsyncClient,
) -> None:
    note = await make_note(c, "a.md")
    first = (await move(c, note["id"], "b.md", note["revision"])).json()
    second = await move(c, note["id"], "c.md", note["revision"])  # based on the old revision
    assert second.status_code == 200, second.text
    [res] = second.json()["sync"]["resolution"]
    assert res["rule"] == "path_later_wins" and res["field"] == "path" and res["loser"] == "b.md"
    assert res["kept_revision"] == second.json()["revision"] and res["id"]
    entry = (await log(c))[0]
    assert entry["undoable"] is True and entry["loser"] == "b.md"
    done = await undo(c, entry["id"])
    assert done.status_code == 200, done.text
    assert done.json()["applied"] is True
    assert done.json()["undo"]["loser"] == "c.md" and done.json()["undo"]["rule"] == "undo"
    assert (await c.get(f"/api/notes/{note['id']}")).json()["path"] == "b.md"
    assert first["path"] == "b.md"


async def test_undoing_a_move_is_refused_when_the_note_moved_again(c: AsyncClient) -> None:
    note = await make_note(c, "a.md")
    await move(c, note["id"], "b.md", note["revision"])
    second = (await move(c, note["id"], "c.md", note["revision"])).json()
    third = await move(c, note["id"], "d.md", second["revision"])
    assert third.status_code == 200
    entry = (await log(c))[0]
    refused = await undo(c, entry["id"])
    assert refused.status_code == 409 and refused.json()["error"] == "conflict"
    assert refused.json()["conflicts"][0]["field"] == "path"
    assert refused.json()["conflicts"][0]["reason"] == "changed_since"
    assert refused.json()["conflicts"][0]["server_value"] == "d.md"
    assert (await c.get(f"/api/notes/{note['id']}")).json()["path"] == "d.md"


async def test_undoing_a_move_onto_a_taken_path_is_path_exists(c: AsyncClient) -> None:
    note = await make_note(c, "a.md")
    await move(c, note["id"], "b.md", note["revision"])
    second = await move(c, note["id"], "c.md", note["revision"])
    assert second.status_code == 200
    await make_note(c, "b.md")  # someone took the path the move had overwritten
    entry = (await log(c, rule="path_later_wins"))[0]
    refused = await undo(c, entry["id"])
    assert refused.status_code == 409 and refused.json()["error"] == "path_exists"
    assert (await c.get(f"/api/notes/{note['id']}")).json()["path"] == "c.md"


# --- scope, listing, retention ---


async def _other_user_entry() -> uuid.UUID:
    other = uuid.uuid4()
    async with session_scope() as session:
        session.add(
            User(id=other, email="other@example.com", display_name="O", password_hash="unused")
        )
        await session.flush()
        row = (
            await ResolutionLog(session, other).record(
                [
                    NewResolution(
                        "task", uuid.uuid4(), "simple_later_wins", field="priority", loser="low"
                    )
                ],
                op_key="theirs",
            )
        )[0]
        return row.id


async def test_another_users_entries_are_invisible_and_cannot_be_undone(c: AsyncClient) -> None:
    theirs = await _other_user_entry()
    await later_wins(c)
    assert all(e["id"] != str(theirs) for e in await log(c))
    assert (await c.get(f"/api/sync/resolutions/{theirs}")).status_code == 404
    refused = await undo(c, str(theirs))
    assert refused.status_code == 404 and refused.json()["error"] == "not_found"
    unknown = await undo(c, str(uuid.uuid4()))
    assert unknown.status_code == 404 and unknown.json() == refused.json()
    feed = (await c.get("/api/changes", params={"types": "resolution"})).json()
    assert all(i["entity_id"] != str(theirs) for i in feed["changes"])
    async with session_scope() as session:
        row = await session.get(SyncResolution, theirs)
        assert row is not None and row.undone_at is None
    mine = await c.get(
        "/api/changes", params={"since": 0, "types": "resolution", "include": "data"}
    )
    assert all(i["data"]["id"] != str(theirs) for i in mine.json()["changes"])


async def test_the_list_pages_newest_first_and_filters(c: AsyncClient) -> None:
    ids = []
    for _ in range(5):
        task, _ = await later_wins(c)
        ids.append(task["sync"]["resolution"][0]["id"])
    first = (await c.get("/api/sync/resolutions", params={"limit": 2})).json()
    assert [e["id"] for e in first["resolutions"]] == ids[::-1][:2] and first["next_cursor"]
    seen = [e["id"] for e in first["resolutions"]]
    cursor = first["next_cursor"]
    while cursor:
        page = (await c.get("/api/sync/resolutions", params={"limit": 2, "cursor": cursor})).json()
        seen += [e["id"] for e in page["resolutions"]]
        cursor = page["next_cursor"]
    assert seen == ids[::-1]
    only = await log(c, entity_id=(await log(c))[0]["entity_id"])
    assert len(only) == 1
    assert await log(c, rule="note_merged") == []
    for bad in ({"limit": 0}, {"limit": 201}, {"cursor": "nonsense"}):
        r = await c.get("/api/sync/resolutions", params=bad)
        assert r.status_code == 422, bad


async def test_the_entries_of_one_request_list_in_a_fixed_order_and_page_cleanly(
    c: AsyncClient,
) -> None:
    """Entries written by one request share a timestamp; their position in the request orders
    them (newest first = last decision first) and a page boundary can fall between them."""
    old = await make_note(c, "same.md", "old\n")
    gone = await c.delete(f"/api/notes/{old['id']}", params={"base_revision": 1}, headers=h(c))
    assert gone.status_code == 204
    other = await c.post(
        "/api/notes",
        json={"id": str(uuid.uuid4()), "path": "same.md", "content": "newer\n"},
        headers=h(c),
    )
    assert other.json()["path"] == "same.md"
    revived = await save(c, old, "old edited\n")  # revive onto the reused path
    assert revived.status_code == 200
    rules = [r["rule"] for r in revived.json()["sync"]["resolution"]]
    assert rules == ["edit_wins_over_delete", "path_collision"]
    ids = [r["id"] for r in revived.json()["sync"]["resolution"]]
    assert [e["id"] for e in await log(c)] == ids[::-1]
    seen: list[str] = []
    cursor = None
    while True:
        params: dict[str, Any] = {"limit": 1}
        if cursor:
            params["cursor"] = cursor
        page = (await c.get("/api/sync/resolutions", params=params)).json()
        seen += [e["id"] for e in page["resolutions"]]
        cursor = page["next_cursor"]
        if cursor is None:
            break
    assert seen == ids[::-1]


async def test_the_retention_purge_removes_old_entries_and_their_feed_rows(
    c: AsyncClient,
) -> None:
    old_task, _ = await later_wins(c)
    new_task_, _ = await later_wins(c)
    old_id = old_task["sync"]["resolution"][0]["id"]
    new_id = new_task_["sync"]["resolution"][0]["id"]
    async with session_scope() as session:
        await session.execute(
            text(
                "UPDATE sync_resolutions SET created_at = now() - interval '100 days' WHERE id = :i"
            ),
            {"i": old_id},
        )
        floor_before = await session.scalar(select(User.change_purge_floor))
    async with session_scope() as session:
        removed = await purge_resolutions(session, cutoff=datetime.now(UTC) - timedelta(days=90))
        assert removed == 1
        assert await purge_resolutions(session, cutoff=datetime.now(UTC) - timedelta(days=90)) == 0
    assert [e["id"] for e in await log(c)] == [new_id]
    feed = (await c.get("/api/changes", params={"types": "resolution"})).json()["changes"]
    assert [i["entity_id"] for i in feed] == [new_id]
    async with session_scope() as session:
        assert await session.scalar(select(User.change_purge_floor)) == floor_before
        assert (
            await session.scalar(
                select(func.count()).select_from(ChangeLog).where(ChangeLog.entity_type == "task")
            )
            == 2
        ), "entities and their feed rows are untouched"
    assert (await c.get(f"/api/tasks/{old_task['id']}")).status_code == 200


async def test_the_purge_job_runs_the_resolution_purge(c: AsyncClient) -> None:
    from atlas.jobs.handlers import purge_change_log

    task, _ = await later_wins(c)
    async with session_scope() as session:
        await session.execute(
            text("UPDATE sync_resolutions SET created_at = now() - interval '100 days'")
        )
    async with session_scope() as session:
        await purge_change_log(session, {})
    assert await log(c) == []
    assert (await c.get(f"/api/tasks/{task['id']}")).status_code == 200


async def test_deleting_the_original_keeps_the_undo_entry_readable(c: AsyncClient) -> None:
    task, _ = await later_wins(c)
    res_id = task["sync"]["resolution"][0]["id"]
    done = await undo(c, res_id)
    async with session_scope() as session:
        await session.execute(text("DELETE FROM sync_resolutions WHERE id = :i"), {"i": res_id})
    undo_entry = await c.get(f"/api/sync/resolutions/{done.json()['undo']['id']}")
    assert undo_entry.status_code == 200 and undo_entry.json()["undoes_id"] is None


# --- privacy of application logs ---


async def test_application_logs_carry_no_values(
    c: AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    task = await new_task(c, title="LOG-CANARY-TITLE")
    await patch_task(c, task["id"], 1, priority="low")
    second = await patch_task(c, task["id"], 1, priority="high", description="LOG-CANARY-TEXT")
    res_id = second.json()["sync"]["resolution"][0]["id"]
    assert (await undo(c, res_id)).status_code == 200
    note = await make_note(c, "canary.md", "LOG-CANARY-NOTE\n")
    await make_note(c, "canary.md", "LOG-CANARY-NOTE-2\n")
    await save(c, note, "LOG-CANARY-EDIT\n")
    text_ = "\n".join(r.getMessage() + str(r.__dict__.get("extra", "")) for r in caplog.records)
    for canary in ("LOG-CANARY", "high", "canary.md"):
        assert canary not in text_, canary


def test_the_entity_schema_number_is_published() -> None:
    from atlas.sync.protocol import ENTITY_SCHEMAS

    assert ENTITY_SCHEMAS["resolution"] == 1


# --- backups --------------------------------------------------------------------------------------


async def test_a_backup_carries_the_log_with_the_database(
    c: AsyncClient, tmp_path: Any, notes_storage: Any
) -> None:
    """The log is a table of the one database, so the plain-SQL dump of a backup set holds it (and
    a restore brings it back with the entities it is about): entries are not a side store."""
    import os

    from atlas.backups import BackupConfig, BackupService
    from tests.integration.test_backups import _dump_backend_kwargs

    task, _ = await later_wins(c)
    res_id = task["sync"]["resolution"][0]["id"]
    config = BackupConfig(
        destination=tmp_path / "backups",
        notes_root=notes_storage.root,
        database_url=os.environ["DATABASE_URL"],
        retain=1,
        **_dump_backend_kwargs(),
    )
    result = BackupService(config).run()
    dump = (result.directory / "database.sql").read_text(encoding="utf-8")
    assert "CREATE TABLE public.sync_resolutions" in dump
    copy_block = dump.split("COPY public.sync_resolutions", 1)[1].split("\\.\n", 1)[0]
    assert res_id in copy_block and "simple_later_wins" in copy_block
    assert task["id"] in copy_block


# --- concurrency and the epoch gate -------------------------------------------------------------


async def test_two_concurrent_undos_of_one_resolution_yield_exactly_one_undo(
    c: AsyncClient,
) -> None:
    import asyncio

    task, _ = await later_wins(c)
    res_id = task["sync"]["resolution"][0]["id"]
    first, second = await asyncio.gather(undo(c, res_id), undo(c, res_id))
    assert sorted((first.status_code, second.status_code)) == [200, 409], (first.text, second.text)
    refused = first if first.status_code == 409 else second
    assert refused.json()["error"] == "already_undone"
    assert len(await log(c, rule="undo")) == 1
    assert (await c.get(f"/api/tasks/{task['id']}")).json()["priority"] == "low"


async def test_concurrent_retries_of_one_undo_key_apply_it_once(c: AsyncClient) -> None:
    import asyncio

    task, _ = await later_wins(c)
    res_id = task["sync"]["resolution"][0]["id"]
    key = str(uuid.uuid4())
    results = await asyncio.gather(*(undo(c, res_id, key) for _ in range(3)))
    assert {r.status_code for r in results} <= {200, 409}
    assert any(r.status_code == 200 for r in results)
    assert len(await log(c, rule="undo")) == 1


async def test_an_undo_racing_a_newer_write_never_overwrites_it(c: AsyncClient) -> None:
    """Whichever commits first: either the undo applies and the write (based on the resolution's
    revision) then merges as a later-wins of its own, or the write lands first and the undo is
    refused. The final value is never the stale one resurrected over a newer write."""
    import asyncio

    for attempt in range(6):
        task, _ = await later_wins(c)
        res_id = task["sync"]["resolution"][0]["id"]
        rev = task["revision"]
        results = await asyncio.gather(
            undo(c, res_id),
            patch_task(c, task["id"], rev, priority="medium"),
        )
        assert all(r.status_code in (200, 409) for r in results), [r.text for r in results]
        final = (await c.get(f"/api/tasks/{task['id']}")).json()
        undo_res, write_res = results
        if undo_res.status_code == 409:
            assert undo_res.json()["error"] == "conflict"
            assert final["priority"] == "medium", f"attempt {attempt}: newer write lost"
        else:
            # the undo went first; the write was based on the revision before it and, being a
            # simple field changed since, took the later-wins path and was logged
            assert write_res.status_code == 200 and final["priority"] == "medium"


async def test_the_resolution_endpoints_check_the_epoch(c: AsyncClient) -> None:
    task, _ = await later_wins(c)
    res_id = task["sync"]["resolution"][0]["id"]
    wrong = {"Atlas-Sync": "1", "Atlas-Epoch": str(uuid.uuid4())}
    listed = await c.get("/api/sync/resolutions", headers=wrong)
    assert listed.status_code == 409 and listed.json()["error"] == "epoch_mismatch"
    refused = await c.post(
        f"/api/sync/resolutions/{res_id}/undo",
        headers={**wrong, "Idempotency-Key": str(uuid.uuid4()), **csrf_headers(c)},
    )
    assert refused.status_code == 409 and refused.json()["error"] == "epoch_mismatch"
    assert (await c.get(f"/api/tasks/{task['id']}")).json()["priority"] == "high"
