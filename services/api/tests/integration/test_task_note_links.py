"""Task↔note links (MU-06) against a real PostgreSQL over HTTP.

Creating a task from a note stores a link to the note's stable id; the note lists its tasks and
projects, the task lists its notes; the link survives a rename; retries create nothing twice;
everything is user-scoped; and Markdown checkboxes never become tasks.
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

import pytest
from sqlalchemy import func, select

from atlas.db import session_scope
from atlas.models import ChangeLog, NoteIndex, Task, TaskLink, User
from tests.conftest import create_user_via_setup, csrf_headers

if TYPE_CHECKING:
    from httpx import AsyncClient


async def _auth(client: AsyncClient) -> dict[str, str]:
    await create_user_via_setup(client)
    return csrf_headers(client)


async def _note(client: AsyncClient, headers: dict[str, str], path: str = "Plan.md", **kw) -> dict:
    body = {"path": path, "content": kw.get("content", "# Plan\n")}
    response = await client.post("/api/notes", json=body, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


async def _from_note(
    client: AsyncClient, headers: dict[str, str], note_id: str, **body: object
) -> dict:
    response = await client.post(
        f"/api/notes/{note_id}/tasks", json={"title": "Do it", **body}, headers=headers
    )
    assert response.status_code == 201, response.text
    return response.json()


async def _count(model: type, *conditions: object) -> int:
    async with session_scope() as session:
        return int(await session.scalar(select(func.count()).select_from(model).where(*conditions)))


async def _foreign_note_and_task() -> tuple[str, str]:
    async with session_scope() as session:
        other = User(
            id=uuid.uuid4(),
            email=f"{uuid.uuid4()}@example.com",
            display_name="Other",
            password_hash="not-used",
        )
        session.add(other)
        await session.flush()
        note = NoteIndex(
            id=uuid.uuid4(),
            user_id=other.id,
            path="Theirs.md",
            title="Theirs",
            content_hash="0" * 64,
            revision=1,
            size_bytes=0,
        )
        task = Task(id=uuid.uuid4(), user_id=other.id, title="Theirs")
        session.add_all([note, task])
        await session.flush()
        session.add(TaskLink(task_id=task.id, note_id=note.id))
        return str(note.id), str(task.id)


async def test_task_from_note_links_both_ways_and_survives_rename(
    notes_client: AsyncClient,
) -> None:
    client = notes_client
    headers = await _auth(client)
    note = await _note(client, headers, content="# Plan\n- [ ] a checkbox is not a task\n")
    project = (await client.post("/api/projects", json={"name": "P"}, headers=headers)).json()
    assert (
        await client.put(f"/api/projects/{project['id']}/notes/{note['id']}", headers=headers)
    ).status_code == 204

    task = await _from_note(client, headers, note["id"], title="Ship it", priority="high")
    assert task["title"] == "Ship it"
    assert task["status"] == "inbox"
    assert await _count(Task) == 1  # the checkbox line produced nothing

    detail = (await client.get(f"/api/notes/{note['id']}")).json()
    assert [(t["id"], t["title"], t["priority"]) for t in detail["tasks"]] == [
        (task["id"], "Ship it", "high")
    ]
    assert [(p["id"], p["name"]) for p in detail["projects"]] == [(project["id"], "P")]

    # The link references the note id, not its path, so a rename keeps it.
    moved = await client.post(
        f"/api/notes/{note['id']}/move", json={"path": "Renamed/Plan.md"}, headers=headers
    )
    assert moved.status_code == 200
    assert [t["id"] for t in moved.json()["tasks"]] == [task["id"]]
    listed = (await client.get(f"/api/tasks/{task['id']}/notes")).json()["notes"]
    assert [(n["id"], n["path"]) for n in listed] == [(note["id"], "Renamed/Plan.md")]

    # Unlinking is idempotent and deletes neither side; it is announced once.
    for _ in range(2):
        response = await client.delete(
            f"/api/tasks/{task['id']}/notes/{note['id']}", headers=headers
        )
        assert response.status_code == 204
    assert (await client.get(f"/api/tasks/{task['id']}/notes")).json()["notes"] == []
    assert (await client.get(f"/api/notes/{note['id']}")).json()["tasks"] == []
    assert (await client.get(f"/api/tasks/{task['id']}")).status_code == 200
    kinds = await _count(ChangeLog, ChangeLog.entity_type == "task_note_link")
    assert kinds == 1  # one feed row per entity (upsert, then delete)


async def test_retry_with_the_same_key_creates_one_task_and_one_link(
    notes_client: AsyncClient,
) -> None:
    client = notes_client
    headers = await _auth(client)
    note = await _note(client, headers)
    keyed = {**headers, "Idempotency-Key": "from-note-1"}
    url = f"/api/notes/{note['id']}/tasks"
    first = await client.post(url, json={"title": "Once"}, headers=keyed)
    again = await client.post(url, json={"title": "Once"}, headers=keyed)
    assert (first.status_code, again.status_code) == (201, 201)
    assert first.json()["id"] == again.json()["id"]
    assert await _count(Task) == 1
    assert await _count(TaskLink) == 1
    # The same key for different content is refused, not silently reused.
    other = await client.post(url, json={"title": "Different"}, headers=keyed)
    assert other.status_code == 409


async def test_deleted_tasks_and_notes_drop_out_and_come_back_with_undo(
    notes_client: AsyncClient,
) -> None:
    client = notes_client
    headers = await _auth(client)
    note = await _note(client, headers)
    task = await _from_note(client, headers, note["id"])
    await client.delete(f"/api/tasks/{task['id']}", headers=headers)
    assert (await client.get(f"/api/notes/{note['id']}")).json()["tasks"] == []
    await client.post(f"/api/tasks/{task['id']}/restore", headers=headers)
    assert len((await client.get(f"/api/notes/{note['id']}")).json()["tasks"]) == 1
    await client.delete(f"/api/notes/{note['id']}", headers=headers)
    assert (await client.get(f"/api/tasks/{task['id']}/notes")).json()["notes"] == []


async def test_invalid_input_writes_nothing_and_reports_the_server_message(
    notes_client: AsyncClient,
) -> None:
    client = notes_client
    headers = await _auth(client)
    note = await _note(client, headers)
    bad_title = await client.post(
        f"/api/notes/{note['id']}/tasks", json={"title": ""}, headers=headers
    )
    assert bad_title.status_code == 422
    unknown_project = await client.post(
        f"/api/notes/{note['id']}/tasks",
        json={"title": "x", "project_id": str(uuid.uuid4())},
        headers=headers,
    )
    assert unknown_project.status_code == 400
    assert await _count(Task) == 0
    assert await _count(TaskLink) == 0


@pytest.mark.parametrize("target", ["foreign", "missing"])
async def test_other_users_and_unknown_ids_are_not_found_and_leak_nothing(
    notes_client: AsyncClient, target: str
) -> None:
    client = notes_client
    headers = await _auth(client)
    mine_note = await _note(client, headers)
    mine_task = await _from_note(client, headers, mine_note["id"])
    if target == "foreign":
        foreign_note, foreign_task = await _foreign_note_and_task()
    else:
        foreign_note = foreign_task = str(uuid.uuid4())

    assert (
        await client.post(f"/api/notes/{foreign_note}/tasks", json={"title": "x"}, headers=headers)
    ).status_code == 404
    assert (await client.get(f"/api/notes/{foreign_note}")).status_code == 404
    assert (await client.get(f"/api/tasks/{foreign_task}/notes")).status_code == 404
    for task_id, note_id in [
        (foreign_task, mine_note["id"]),
        (mine_task["id"], foreign_note),
    ]:
        response = await client.delete(f"/api/tasks/{task_id}/notes/{note_id}", headers=headers)
        assert response.status_code == 404
    expected = 2 if target == "foreign" else 1  # mine plus theirs; nothing of mine was removed
    assert await _count(TaskLink) == expected
    assert await _count(Task) == expected


async def test_endpoints_require_authentication(notes_client: AsyncClient) -> None:
    ids = (uuid.uuid4(), uuid.uuid4())
    assert (
        await notes_client.post(f"/api/notes/{ids[0]}/tasks", json={"title": "x"})
    ).status_code in (401, 403)
    assert (await notes_client.get(f"/api/tasks/{ids[0]}/notes")).status_code == 401
