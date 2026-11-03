"""Check-then-write races on ``base_revision`` (R-37, SYNC-03) against a real PostgreSQL.

Every write path that takes a ``base_revision`` (task PATCH, project PATCH, note PUT) must make the
revision check and the write one atomic step: of two requests carrying the same base revision
exactly one wins, the other gets ``409`` with the current revision, and no two different states
ever share a revision. The requests are really concurrent (separate sessions and transactions via
``asyncio.gather``); a sequential test cannot see this bug.

Each test repeats the race several times: before the fix the lost update reproduced 8 of 8 times
for tasks, so a single pass is already decisive, but repetition guards against a lucky ordering.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

import pytest
from httpx import AsyncClient, Response
from sqlalchemy import select

from atlas.changes import ChangesService
from atlas.db import session_scope
from atlas.models import ChangeLog, Project, Task, User
from atlas.notes import NotesStorage
from tests.conftest import create_user_via_setup, csrf_headers

pytestmark = pytest.mark.usefixtures("_db")

ATTEMPTS = 8


async def _race(
    client: AsyncClient,
    get_revision: Callable[[], Awaitable[int]],
    send: Callable[[str, int], Awaitable[Response]],
    read_back: Callable[[], Awaitable[Any]],
) -> None:
    for attempt in range(ATTEMPTS):
        base = await get_revision()
        first, second = await asyncio.gather(send(f"a{attempt}", base), send(f"b{attempt}", base))
        statuses = sorted((first.status_code, second.status_code))
        assert statuses == [200, 409], f"attempt {attempt}: {statuses}"
        winner, loser = (first, second) if first.status_code == 200 else (second, first)
        assert winner.json()["revision"] == base + 1
        conflict = loser.json()["detail"]
        assert conflict["current_revision"] == base + 1, conflict
        assert await get_revision() == base + 1
        # The stored state is the winner's, not a blend or the loser's.
        assert await read_back() == winner.json()


# --- tasks ---------------------------------------------------------------------------------


async def test_concurrent_task_patches_with_one_base_revision_cannot_both_win(
    client: AsyncClient,
) -> None:
    await create_user_via_setup(client)
    headers = csrf_headers(client)
    task = (await client.post("/api/tasks", json={"title": "t"}, headers=headers)).json()
    url = f"/api/tasks/{task['id']}"

    async def revision() -> int:
        return int((await client.get(url)).json()["revision"])

    async def send(title: str, base: int) -> Response:
        return await client.patch(
            url, json={"title": title, "base_revision": base}, headers=headers
        )

    async def read_back() -> Any:
        return (await client.get(url)).json()

    await _race(client, revision, send, read_back)


async def test_a_replayed_idempotency_key_still_returns_the_original_result(
    client: AsyncClient,
) -> None:
    await create_user_via_setup(client)
    headers = csrf_headers(client)
    task = (await client.post("/api/tasks", json={"title": "t"}, headers=headers)).json()
    url = f"/api/tasks/{task['id']}"
    keyed = {**headers, "Idempotency-Key": str(uuid.uuid4())}
    body = {"title": "once", "base_revision": task["revision"]}

    first = await client.patch(url, json=body, headers=keyed)
    replay = await client.patch(url, json=body, headers=keyed)

    assert first.status_code == 200
    assert replay.status_code == 200
    assert replay.json() == first.json()
    assert (await client.get(url)).json()["revision"] == task["revision"] + 1


async def test_concurrent_task_delete_and_patch_are_serialised(client: AsyncClient) -> None:
    """A delete racing a patch never leaves two states under one revision."""
    await create_user_via_setup(client)
    headers = csrf_headers(client)
    for attempt in range(ATTEMPTS):
        task = (
            await client.post("/api/tasks", json={"title": f"t{attempt}"}, headers=headers)
        ).json()
        url = f"/api/tasks/{task['id']}"
        patch, delete = await asyncio.gather(
            client.patch(
                url, json={"title": "x", "base_revision": task["revision"]}, headers=headers
            ),
            client.delete(url, headers=headers),
        )
        assert delete.status_code == 204
        assert patch.status_code in (200, 404)
        async with session_scope() as session:
            row = await session.get(Task, uuid.UUID(task["id"]))
            assert row is not None and row.deleted_at is not None
            # create = 1; delete always bumps; a patch that ran first bumped once more.
            assert row.revision == task["revision"] + (2 if patch.status_code == 200 else 1)


async def test_concurrent_deletes_of_a_parent_and_project_unfiling_do_not_deadlock(
    client: AsyncClient,
) -> None:
    """Parent delete (promotes children) vs project delete (unfiles): one task lock order."""
    await create_user_via_setup(client)
    headers = csrf_headers(client)
    for attempt in range(ATTEMPTS):
        project = (
            await client.post("/api/projects", json={"name": f"p{attempt}"}, headers=headers)
        ).json()
        parent = (
            await client.post(
                "/api/tasks", json={"title": "parent", "project_id": project["id"]}, headers=headers
            )
        ).json()
        for index in range(4):
            await client.post(
                "/api/tasks",
                json={"title": f"c{index}", "parent_task_id": parent["id"]},
                headers=headers,
            )
        first, second = await asyncio.gather(
            client.delete(f"/api/tasks/{parent['id']}", headers=headers),
            client.delete(f"/api/projects/{project['id']}", headers=headers),
        )
        assert (first.status_code, second.status_code) == (204, 204)


# --- projects ------------------------------------------------------------------------------


async def test_concurrent_project_patches_with_one_base_revision_cannot_both_win(
    client: AsyncClient,
) -> None:
    await create_user_via_setup(client)
    headers = csrf_headers(client)
    project = (await client.post("/api/projects", json={"name": "p"}, headers=headers)).json()
    url = f"/api/projects/{project['id']}"

    async def revision() -> int:
        return int((await client.get(url)).json()["revision"])

    async def send(name: str, base: int) -> Response:
        return await client.patch(url, json={"name": name, "base_revision": base}, headers=headers)

    async def read_back() -> Any:
        return (await client.get(url)).json()

    await _race(client, revision, send, read_back)


# --- notes ---------------------------------------------------------------------------------


async def test_concurrent_note_puts_with_one_base_revision_cannot_both_win(
    notes_client: AsyncClient, notes_storage: NotesStorage
) -> None:
    client = notes_client
    await create_user_via_setup(client)
    headers = csrf_headers(client)
    note = (
        await client.post(
            "/api/notes", json={"path": "Race.md", "content": "# Race\n"}, headers=headers
        )
    ).json()
    url = f"/api/notes/{note['id']}"

    async def revision() -> int:
        return int((await client.get(url)).json()["revision"])

    async def send(label: str, base: int) -> Response:
        return await client.put(
            url, json={"content": f"# Race\n\n{label}\n", "base_revision": base}, headers=headers
        )

    async def read_back() -> Any:
        stored = (await client.get(url)).json()
        # The file on disk is the winner's content, and the index agrees with it.
        assert (notes_storage.root / "Race.md").read_text(encoding="utf-8") == stored["content"]
        return stored

    await _race(client, revision, send, read_back)


# --- the change feed stays consistent ------------------------------------------------------


async def test_a_losing_patch_leaves_no_feed_entry(client: AsyncClient) -> None:
    await create_user_via_setup(client)
    headers = csrf_headers(client)
    task = (await client.post("/api/tasks", json={"title": "t"}, headers=headers)).json()
    url = f"/api/tasks/{task['id']}"
    async with session_scope() as session:
        head_before = int(await session.scalar(select(User.change_seq)) or 0)
    results = await asyncio.gather(
        *(
            client.patch(url, json={"title": f"x{n}", "base_revision": 1}, headers=headers)
            for n in range(4)
        )
    )
    assert sorted(r.status_code for r in results) == [200, 409, 409, 409]
    async with session_scope() as session:
        head_after = int(await session.scalar(select(User.change_seq)) or 0)
        entry = await session.scalar(select(ChangeLog).where(ChangeLog.entity_id == task["id"]))
    assert head_after == head_before + 1, "only the winner advanced the cursor"
    assert entry is not None and entry.seq == head_after
    page = None
    async with session_scope() as session:
        owner = await session.scalar(select(User.id))
        assert owner is not None
        page = await ChangesService(session, owner).changes(since=head_before, limit=10)
    assert [c.entity_id for c in page.changes] == [task["id"]]


# --- a task must never end up live in a deleted project (R-37 residual) --------------------


async def _live_tasks_in_deleted_projects() -> list[str]:
    async with session_scope() as session:
        rows = await session.execute(
            select(Task.title)
            .join(Project, Project.id == Task.project_id)
            .where(Task.deleted_at.is_(None), Project.deleted_at.is_not(None))
        )
        return [row.title for row in rows]


async def test_moving_a_task_into_a_project_while_it_is_deleted_never_strands_the_task(
    client: AsyncClient,
) -> None:
    await create_user_via_setup(client)
    headers = csrf_headers(client)
    outcomes: set[tuple[int, int]] = set()
    for attempt in range(ATTEMPTS * 2):
        project = (
            await client.post("/api/projects", json={"name": f"p{attempt}"}, headers=headers)
        ).json()
        task = (
            await client.post("/api/tasks", json={"title": f"t{attempt}"}, headers=headers)
        ).json()
        move, delete = await asyncio.gather(
            client.patch(
                f"/api/tasks/{task['id']}", json={"project_id": project["id"]}, headers=headers
            ),
            client.delete(f"/api/projects/{project['id']}", headers=headers),
        )
        assert delete.status_code == 204
        assert move.status_code in (200, 400), move.text  # 400: the project was already gone
        outcomes.add((move.status_code, delete.status_code))
        assert await _live_tasks_in_deleted_projects() == []
    assert outcomes <= {(200, 204), (400, 204)}


async def test_creating_or_restoring_a_task_in_a_project_while_it_is_deleted_never_strands_it(
    client: AsyncClient,
) -> None:
    await create_user_via_setup(client)
    headers = csrf_headers(client)
    for attempt in range(ATTEMPTS * 2):
        project = (
            await client.post("/api/projects", json={"name": f"p{attempt}"}, headers=headers)
        ).json()
        gone = (
            await client.post(
                "/api/tasks",
                json={"title": f"g{attempt}", "project_id": project["id"]},
                headers=headers,
            )
        ).json()
        assert (await client.delete(f"/api/tasks/{gone['id']}", headers=headers)).status_code == 204
        create, restore, delete = await asyncio.gather(
            client.post(
                "/api/tasks",
                json={"title": f"n{attempt}", "project_id": project["id"]},
                headers=headers,
            ),
            client.post(f"/api/tasks/{gone['id']}/restore", headers=headers),
            client.delete(f"/api/projects/{project['id']}", headers=headers),
        )
        assert delete.status_code == 204
        assert create.status_code in (201, 400), create.text
        assert restore.status_code == 200, restore.text
        assert await _live_tasks_in_deleted_projects() == []


async def test_swapping_tasks_between_projects_while_both_are_deleted_does_not_deadlock(
    client: AsyncClient,
) -> None:
    """Four writers, each holding what the next needs unless every path locks project then task."""
    await create_user_via_setup(client)
    headers = csrf_headers(client)
    for attempt in range(ATTEMPTS * 2):
        x = (
            await client.post("/api/projects", json={"name": f"x{attempt}"}, headers=headers)
        ).json()
        y = (
            await client.post("/api/projects", json={"name": f"y{attempt}"}, headers=headers)
        ).json()
        in_x = (
            await client.post(
                "/api/tasks", json={"title": "a", "project_id": x["id"]}, headers=headers
            )
        ).json()
        in_y = (
            await client.post(
                "/api/tasks", json={"title": "b", "project_id": y["id"]}, headers=headers
            )
        ).json()
        results = await asyncio.gather(
            client.patch(f"/api/tasks/{in_x['id']}", json={"project_id": y["id"]}, headers=headers),
            client.patch(f"/api/tasks/{in_y['id']}", json={"project_id": x["id"]}, headers=headers),
            client.delete(f"/api/projects/{x['id']}", headers=headers),
            client.delete(f"/api/projects/{y['id']}", headers=headers),
        )
        assert all(r.status_code < 500 for r in results), [r.status_code for r in results]
        assert await _live_tasks_in_deleted_projects() == []


async def test_a_note_edit_and_a_task_created_from_that_note_do_not_deadlock(
    notes_client: AsyncClient,
) -> None:
    """The note row lock must not block the new task link's foreign-key check (NO KEY UPDATE)."""
    client = notes_client
    await create_user_via_setup(client)
    headers = csrf_headers(client)
    note = (
        await client.post(
            "/api/notes", json={"path": "Src.md", "content": "# s\n"}, headers=headers
        )
    ).json()
    revision = note["revision"]
    for attempt in range(ATTEMPTS * 2):
        edit, task = await asyncio.gather(
            client.put(
                f"/api/notes/{note['id']}",
                json={"content": f"# s\n\n{attempt}\n", "base_revision": revision},
                headers=headers,
            ),
            client.post(
                f"/api/notes/{note['id']}/tasks", json={"title": f"t{attempt}"}, headers=headers
            ),
        )
        assert edit.status_code == 200 and task.status_code == 201, (edit.text, task.text)
        revision = edit.json()["revision"]
