"""Per-user change feed (M7-01) against a real PostgreSQL over HTTP.

Covers the acceptance criteria: an empty feed; create/update/delete of each entity type appearing
with the right operation; a twice-changed entity appearing once at its latest cursor; paging across
a limit boundary staying complete and duplicate-free; a cursor at/above the high-water mark
returning nothing; the counter not churning on an idempotent no-op; boundary validation with no side
effects; strict user isolation; and that the endpoint is read-only. Requires a database.
"""

from __future__ import annotations

import uuid

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from atlas.auth import hash_password
from atlas.changes import MAX_CURSOR
from atlas.db import session_scope
from atlas.models import ChangeLog, User
from atlas.notes import NotesStorage
from tests.conftest import create_user_via_setup, csrf_headers


async def _auth(client: AsyncClient) -> dict[str, str]:
    await create_user_via_setup(client)
    return csrf_headers(client)


async def _pull(client: AsyncClient, *, since: object = None, limit: object = None) -> dict:
    supplied = (("since", since), ("limit", limit))
    params = {key: value for key, value in supplied if value is not None}
    response = await client.get("/api/changes", params=params)
    assert response.status_code == 200, response.text
    body = response.json()
    assert {"changes", "since", "next_since", "has_more"} <= set(body)
    return body


def _keys(changes: list[dict]) -> list[tuple[str, str]]:
    return [(change["entity_type"], change["entity_id"]) for change in changes]


def _operations(changes: list[dict]) -> dict[tuple[str, str], str]:
    return {(change["entity_type"], change["entity_id"]): change["operation"] for change in changes}


async def _drain(client: AsyncClient, *, limit: int) -> list[dict]:
    """Page from cursor 0 until ``has_more`` is false, returning every change item seen."""
    collected: list[dict] = []
    since = 0
    for _ in range(50):
        body = await _pull(client, since=since, limit=limit)
        cursors = [change["cursor"] for change in body["changes"]]
        assert cursors == sorted(cursors), "a page is ordered by cursor ascending"
        collected.extend(body["changes"])
        assert body["next_since"] >= since
        if not body["has_more"]:
            return collected
        assert body["next_since"] > since, "a page with more must advance the cursor"
        since = body["next_since"]
    raise AssertionError("paging did not converge")


async def _create_task(client: AsyncClient, headers: dict[str, str], title: str = "T") -> dict:
    response = await client.post("/api/tasks", json={"title": title}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


async def _create_project(client: AsyncClient, headers: dict[str, str], name: str = "P") -> dict:
    response = await client.post("/api/projects", json={"name": name}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


# --- basics -------------------------------------------------------------------


async def test_the_change_set_is_empty_for_a_new_user(client: AsyncClient) -> None:
    await _auth(client)

    body = await _pull(client)

    assert body["changes"] == []
    assert body["since"] == 0
    assert body["next_since"] == 0
    assert body["has_more"] is False


async def test_changes_require_authentication(client: AsyncClient) -> None:
    assert (await client.get("/api/changes")).status_code == 401


async def test_the_endpoint_is_read_only(client: AsyncClient) -> None:
    headers = await _auth(client)
    # GET is the only method; POST is rejected by the framework (405), not handled as a mutation.
    assert (await client.post("/api/changes", headers=headers)).status_code == 405


# --- each entity type ---------------------------------------------------------


async def test_task_create_update_delete_appear_with_the_right_operation(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    task = await _create_task(client, headers, title="Draft")

    created = await _pull(client)
    assert _operations(created["changes"]) == {("task", task["id"]): "upsert"}

    assert (
        await client.patch(f"/api/tasks/{task['id']}", json={"title": "Done"}, headers=headers)
    ).status_code == 200
    assert (await client.delete(f"/api/tasks/{task['id']}", headers=headers)).status_code == 204

    after = await _pull(client)
    # One row for the task, at its latest operation (the soft delete).
    assert _keys(after["changes"]) == [("task", task["id"])]
    assert after["changes"][0]["operation"] == "delete"


async def test_project_create_update_delete_appear_with_the_right_operation(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    project = await _create_project(client, headers, name="Launch")

    created = await _pull(client)
    assert _operations(created["changes"]) == {("project", project["id"]): "upsert"}

    assert (
        await client.patch(
            f"/api/projects/{project['id']}", json={"name": "Renamed"}, headers=headers
        )
    ).status_code == 200
    deleted = await client.delete(f"/api/projects/{project['id']}", headers=headers)
    assert deleted.status_code == 204

    after = await _pull(client)
    assert _keys(after["changes"]) == [("project", project["id"])]
    assert after["changes"][0]["operation"] == "delete"


async def test_note_create_update_delete_appear_with_the_right_operation(
    notes_client: AsyncClient,
) -> None:
    headers = await _auth(notes_client)
    created = await notes_client.post(
        "/api/notes", json={"path": "Note.md", "content": "# One\n"}, headers=headers
    )
    assert created.status_code == 201, created.text
    note = created.json()

    feed = await _pull(notes_client)
    assert _operations(feed["changes"]) == {("note", note["id"]): "upsert"}

    updated = await notes_client.put(
        f"/api/notes/{note['id']}",
        json={"content": "# Two\n", "base_revision": note["revision"]},
        headers=headers,
    )
    assert updated.status_code == 200, updated.text
    deleted = await notes_client.delete(f"/api/notes/{note['id']}", headers=headers)
    assert deleted.status_code == 204

    after = await _pull(notes_client)
    assert _keys(after["changes"]) == [("note", note["id"])]
    assert after["changes"][0]["operation"] == "delete"


async def test_note_project_links_appear_as_upsert_then_delete(notes_client: AsyncClient) -> None:
    headers = await _auth(notes_client)
    note = (
        await notes_client.post(
            "/api/notes", json={"path": "Note.md", "content": "# N\n"}, headers=headers
        )
    ).json()
    project = await _create_project(notes_client, headers, name="Launch")

    assert (
        await notes_client.put(f"/api/projects/{project['id']}/notes/{note['id']}", headers=headers)
    ).status_code == 204
    link_key = ("note_project_link", f"{note['id']}:{project['id']}")
    linked = await _pull(notes_client)
    assert _operations(linked["changes"])[link_key] == "upsert"

    assert (
        await notes_client.delete(
            f"/api/projects/{project['id']}/notes/{note['id']}", headers=headers
        )
    ).status_code == 204
    unlinked = await _pull(notes_client)
    assert _operations(unlinked["changes"])[link_key] == "delete"


async def test_an_idempotent_relink_does_not_churn_the_feed(notes_client: AsyncClient) -> None:
    headers = await _auth(notes_client)
    note = (
        await notes_client.post(
            "/api/notes", json={"path": "Note.md", "content": "# N\n"}, headers=headers
        )
    ).json()
    project = await _create_project(notes_client, headers, name="Launch")
    url = f"/api/projects/{project['id']}/notes/{note['id']}"
    assert (await notes_client.put(url, headers=headers)).status_code == 204

    high_water = (await _pull(notes_client))["next_since"]
    # Linking again is a no-op, so nothing changed after the high-water mark.
    assert (await notes_client.put(url, headers=headers)).status_code == 204

    assert (await _pull(notes_client, since=high_water))["changes"] == []


async def test_deleting_a_project_announces_the_unfiled_task_and_the_link(
    notes_client: AsyncClient,
) -> None:
    headers = await _auth(notes_client)
    project = await _create_project(notes_client, headers, name="Launch")
    task = await _create_task(notes_client, headers, title="Filed")
    assert (
        await notes_client.patch(
            f"/api/tasks/{task['id']}", json={"project_id": project["id"]}, headers=headers
        )
    ).status_code == 200
    note = (
        await notes_client.post(
            "/api/notes", json={"path": "Note.md", "content": "# N\n"}, headers=headers
        )
    ).json()
    assert (
        await notes_client.put(f"/api/projects/{project['id']}/notes/{note['id']}", headers=headers)
    ).status_code == 204

    removed = await notes_client.delete(f"/api/projects/{project['id']}", headers=headers)
    assert removed.status_code == 204

    operations = _operations((await _pull(notes_client))["changes"])
    assert operations[("project", project["id"])] == "delete"
    assert operations[("task", task["id"])] == "upsert"  # the task was un-filed
    assert operations[("note_project_link", f"{note['id']}:{project['id']}")] == "delete"


# --- ordering, dedupe and paging ----------------------------------------------


async def test_a_task_changed_twice_between_pulls_appears_once_at_its_latest_cursor(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    task = await _create_task(client, headers, title="Draft")

    first = await _pull(client)
    assert _keys(first["changes"]) == [("task", task["id"])]
    first_cursor = first["changes"][0]["cursor"]

    for title in ("Edit one", "Edit two"):
        assert (
            await client.patch(f"/api/tasks/{task['id']}", json={"title": title}, headers=headers)
        ).status_code == 200

    # Since 0 the task appears exactly once, and at a cursor higher than the first pull saw.
    everything = await _pull(client)
    assert _keys(everything["changes"]) == [("task", task["id"])]
    assert everything["changes"][0]["cursor"] > first_cursor
    assert everything["changes"][0]["operation"] == "upsert"


async def test_paging_is_complete_and_duplicate_free_across_entity_types(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    created: set[tuple[str, str]] = set()
    for index in range(3):
        task = await _create_task(client, headers, title=f"Task {index}")
        created.add(("task", task["id"]))
        project = await _create_project(client, headers, name=f"Project {index}")
        created.add(("project", project["id"]))

    for limit in (1, 2, 3, 5, 200):
        seen = _keys(await _drain(client, limit=limit))
        assert set(seen) == created, limit
        assert len(seen) == len(created), limit  # exactly once: no gaps, no duplicates


async def test_a_cursor_at_the_high_water_mark_returns_nothing(client: AsyncClient) -> None:
    headers = await _auth(client)
    await _create_task(client, headers, title="A")
    await _create_task(client, headers, title="B")

    high_water = (await _pull(client))["next_since"]

    at_head = await _pull(client, since=high_water)
    assert at_head["changes"] == []
    assert at_head["resync_required"] is False
    assert at_head["resync_reason"] is None


async def test_a_cursor_ahead_of_the_server_head_gets_an_explicit_resync_signal(
    client: AsyncClient,
) -> None:
    """SYNC-01 (b): a restored server must not look "up to date" to a client that is ahead."""
    headers = await _auth(client)
    await _create_task(client, headers, title="A")
    await _create_task(client, headers, title="B")
    head = (await _pull(client))["next_since"]

    for ahead in (head + 1, head + 10, MAX_CURSOR):
        body = await _pull(client, since=ahead)
        assert body["resync_required"] is True, ahead
        assert body["resync_reason"] == "cursor_ahead", ahead
        assert body["changes"] == []
        assert body["has_more"] is False
        assert body["since"] == ahead
        assert body["next_since"] == head  # the head the client would resume from

    # A cursor at the head, or any cursor below it, is still an ordinary incremental pull.
    for ordinary in (0, head - 1, head):
        body = await _pull(client, since=ordinary)
        assert body["resync_required"] is False, ordinary
        assert body["resync_reason"] is None, ordinary


async def test_a_new_user_at_cursor_zero_is_not_ahead(client: AsyncClient) -> None:
    await _auth(client)
    body = await _pull(client, since=0)
    assert body["resync_required"] is False
    assert (await _pull(client, since=1))["resync_reason"] == "cursor_ahead"


async def test_cursor_ahead_is_a_read_only_answer(client: AsyncClient) -> None:
    headers = await _auth(client)
    await _create_task(client, headers)
    async with session_scope() as session:
        before = await session.scalar(select(User.change_seq))
    await _pull(client, since=500)
    async with session_scope() as session:
        assert await session.scalar(select(User.change_seq)) == before


async def test_a_reconciled_external_edit_reaches_a_client_through_the_feed(
    notes_client: AsyncClient, notes_storage: NotesStorage
) -> None:
    """SYNC-01 (a) end to end: edit a file on the server, run reconcile, pull the change."""
    headers = await _auth(notes_client)
    created = await notes_client.post(
        "/api/notes", json={"path": "Ext.md", "content": "# One\n"}, headers=headers
    )
    note = created.json()
    cursor = (await _pull(notes_client))["next_since"]

    (notes_storage.root / "Ext.md").write_text("# Two\n", encoding="utf-8")
    reconcile = await notes_client.post("/api/notes/reconcile", headers=headers)
    assert reconcile.status_code == 200, reconcile.text

    feed = await _pull(notes_client, since=cursor)
    assert _operations(feed["changes"]) == {("note", note["id"]): "upsert"}
    assert feed["next_since"] > cursor


# --- validation and security --------------------------------------------------


async def test_an_invalid_cursor_or_limit_is_rejected_without_side_effects(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    await _create_task(client, headers, title="Existing")
    before = await _pull(client)

    for params in (
        {"since": "-1"},
        {"since": str(MAX_CURSOR + 1)},
        {"since": "not-a-number"},
        {"limit": "0"},
        {"limit": "501"},
        {"limit": "not-a-number"},
    ):
        response = await client.get("/api/changes", params=params)
        assert response.status_code == 422, (params, response.text)

    after = await _pull(client)
    assert after == before


async def test_changes_are_strictly_user_scoped(client: AsyncClient, app: FastAPI) -> None:
    headers = await _auth(client)
    mine = await _create_task(client, headers, title="Mine")

    # A second, independently authenticated user records their own change.
    other_email = f"{uuid.uuid4()}@example.com"
    other_password = "another correct horse"
    async with session_scope() as session:
        session.add(
            User(
                id=uuid.uuid4(),
                email=other_email,
                display_name="Other",
                password_hash=hash_password(other_password),
            )
        )
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as other:
        assert (
            await other.post(
                "/api/auth/login", json={"email": other_email, "password": other_password}
            )
        ).status_code == 200
        other_headers = csrf_headers(other)
        theirs = await _create_task(other, other_headers, title="Theirs")

        their_feed = await _pull(other)
        assert _keys(their_feed["changes"]) == [("task", theirs["id"])]

    # The first user's feed never contains the other user's change, and vice versa.
    my_feed = await _pull(client)
    assert _keys(my_feed["changes"]) == [("task", mine["id"])]


async def test_another_users_change_row_is_invisible(client: AsyncClient) -> None:
    headers = await _auth(client)
    mine = await _create_task(client, headers, title="Mine")

    async with session_scope() as session:
        other = User(
            id=uuid.uuid4(),
            email=f"{uuid.uuid4()}@example.com",
            display_name="Other",
            password_hash="not-used",
        )
        session.add(other)
        await session.flush()
        # A high cursor and a tombstone: neither must influence the caller's feed or their cursor.
        session.add(
            ChangeLog(
                user_id=other.id,
                entity_type="task",
                entity_id=str(uuid.uuid4()),
                operation="delete",
                seq=5000,
            )
        )

    body = await _pull(client)
    assert _keys(body["changes"]) == [("task", mine["id"])]
    assert body["next_since"] == 1
