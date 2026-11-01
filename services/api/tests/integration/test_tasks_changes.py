"""Task change log / incremental pull (M3-09) against a real PostgreSQL over HTTP.

Covers the acceptance criteria: an empty change set; create-then-pull; an update bumping the
revision so the task re-appears once at the higher revision; soft deletes surfacing as tombstones;
a cursor at/above the high-water mark returning nothing; paging across a limit boundary staying
complete and duplicate-free (including runs of equal revisions); boundary validation with no side
effects; and user isolation. Requires a database (``client`` pulls in ``_db``).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from httpx import AsyncClient

from atlas.db import session_scope
from atlas.models import Task, User
from atlas.tasks import MAX_SINCE
from tests.conftest import create_user_via_setup, csrf_headers


async def _auth(client: AsyncClient) -> dict[str, str]:
    await create_user_via_setup(client)
    return csrf_headers(client)


async def _create(client: AsyncClient, headers: dict[str, str], **payload: object) -> dict:
    response = await client.post("/api/tasks", json={"title": "T", **payload}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


async def _pull(client: AsyncClient, *, since: object = None, limit: object = None) -> dict:
    supplied = (("since", since), ("limit", limit))
    params = {key: value for key, value in supplied if value is not None}
    response = await client.get("/api/tasks/changes", params=params)
    assert response.status_code == 200, response.text
    body = response.json()
    assert {"tasks", "since", "next_since", "has_more"} <= set(body)
    return body


def _ids(tasks: list[dict]) -> list[str]:
    return [task["id"] for task in tasks]


async def _drain(client: AsyncClient, *, limit: int) -> list[dict]:
    """Page from cursor 0 until ``has_more`` is false, returning every change item seen."""
    collected: list[dict] = []
    since = 0
    for _ in range(50):
        body = await _pull(client, since=since, limit=limit)
        revisions = [task["revision"] for task in body["tasks"]]
        assert revisions == sorted(revisions), "a page is ordered by revision ascending"
        collected.extend(body["tasks"])
        assert body["next_since"] >= since
        if not body["has_more"]:
            return collected
        assert body["next_since"] > since, "a page with more must advance the cursor"
        since = body["next_since"]
    raise AssertionError("paging did not converge")


# --- basics -------------------------------------------------------------------


async def test_the_change_set_is_empty_for_a_new_user(client: AsyncClient) -> None:
    await _auth(client)

    body = await _pull(client)

    assert body["tasks"] == []
    assert body["since"] == 0
    assert body["next_since"] == 0
    assert body["has_more"] is False


async def test_creating_tasks_then_pulling_returns_them(client: AsyncClient) -> None:
    headers = await _auth(client)
    first = await _create(client, headers, title="First")
    second = await _create(client, headers, title="Second")

    body = await _pull(client)

    assert set(_ids(body["tasks"])) == {first["id"], second["id"]}
    assert body["since"] == 0
    assert body["next_since"] == 1
    assert body["has_more"] is False
    # The whole change set was delivered: a pull at the new high-water mark is empty.
    assert await _pull(client, since=body["next_since"]) == {
        "tasks": [],
        "since": 1,
        "next_since": 1,
        "has_more": False,
    }


async def test_an_update_bumps_the_revision_and_reappears_once(client: AsyncClient) -> None:
    headers = await _auth(client)
    task = await _create(client, headers, title="Draft")

    first = await _pull(client)
    assert _ids(first["tasks"]) == [task["id"]]
    assert first["next_since"] == 1

    assert (
        await client.patch(f"/api/tasks/{task['id']}", json={"title": "Edit one"}, headers=headers)
    ).status_code == 200
    assert (
        await client.patch(f"/api/tasks/{task['id']}", json={"title": "Edit two"}, headers=headers)
    ).status_code == 200

    # Two bumps between pulls: the task appears once, at its latest revision.
    second = await _pull(client, since=first["next_since"])
    assert _ids(second["tasks"]) == [task["id"]]
    assert second["tasks"][0]["revision"] == 3
    assert second["tasks"][0]["title"] == "Edit two"
    assert second["next_since"] == 3
    assert second["has_more"] is False

    assert (await _pull(client, since=second["next_since"]))["tasks"] == []


async def test_a_soft_delete_appears_as_a_tombstone(client: AsyncClient) -> None:
    headers = await _auth(client)
    kept = await _create(client, headers, title="Kept")
    doomed = await _create(client, headers, title="Doomed")

    assert (await client.delete(f"/api/tasks/{doomed['id']}", headers=headers)).status_code == 204

    everything = await _pull(client)
    by_id = {task["id"]: task for task in everything["tasks"]}
    assert set(by_id) == {kept["id"], doomed["id"]}
    # Both are live as far as the change feed is concerned, but the deleted one is a tombstone.
    assert by_id[kept["id"]]["deleted_at"] is None
    tombstone = by_id[doomed["id"]]
    assert tombstone["deleted_at"] is not None
    assert tombstone["revision"] == 2

    # Past revision 1 only the deletion remains to be delivered.
    after = await _pull(client, since=1)
    assert _ids(after["tasks"]) == [doomed["id"]]
    assert after["tasks"][0]["deleted_at"] is not None


async def test_a_cursor_at_the_high_water_mark_returns_nothing(client: AsyncClient) -> None:
    headers = await _auth(client)
    await _create(client, headers, title="A")
    await _create(client, headers, title="B")

    high_water = (await _pull(client))["next_since"]

    assert (await _pull(client, since=high_water))["tasks"] == []
    assert (await _pull(client, since=high_water + 10))["tasks"] == []


# --- paging -------------------------------------------------------------------


async def test_paging_is_complete_and_duplicate_free_across_revision_ties(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    created = [await _create(client, headers, title=f"Task {index}") for index in range(5)]
    # Bump two of them so the change set mixes revision 1 and 2 (ties on both sides of a boundary).
    for task in created[:2]:
        assert (
            await client.patch(
                f"/api/tasks/{task['id']}", json={"title": "bumped"}, headers=headers
            )
        ).status_code == 200

    expected = {task["id"] for task in created}
    for limit in (1, 2, 3, 4, 200):
        seen = _ids(await _drain(client, limit=limit))
        assert set(seen) == expected, limit
        assert len(seen) == len(expected), limit  # exactly once: no gaps, no duplicates


async def test_a_single_revision_group_larger_than_the_limit_is_returned_whole(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    created = [await _create(client, headers, title=f"Fresh {index}") for index in range(4)]

    # Every task is revision 1, so a limit of 1 cannot split the group: the page extends to the end
    # of the run and the cursor advances, rather than stalling on a group it cannot divide.
    body = await _pull(client, since=0, limit=1)

    assert set(_ids(body["tasks"])) == {task["id"] for task in created}
    assert body["next_since"] == 1
    assert body["has_more"] is False


# --- validation and security --------------------------------------------------


async def test_changes_require_authentication(client: AsyncClient) -> None:
    assert (await client.get("/api/tasks/changes")).status_code == 401


async def test_an_invalid_cursor_or_limit_is_rejected_without_side_effects(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    task = await _create(client, headers, title="Existing")
    before = await _pull(client)

    for params in (
        {"since": "-1"},
        {"since": str(MAX_SINCE + 1)},
        {"since": "not-a-number"},
        {"limit": "0"},
        {"limit": "501"},
        {"limit": "not-a-number"},
    ):
        response = await client.get("/api/tasks/changes", params=params)
        assert response.status_code == 422, (params, response.text)

    after = await _pull(client)
    assert after == before
    assert _ids(after["tasks"]) == [task["id"]]
    assert after["tasks"][0]["revision"] == 1


async def test_changes_are_strictly_user_scoped(client: AsyncClient) -> None:
    headers = await _auth(client)
    mine = await _create(client, headers, title="Mine")

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
        # A high revision and a tombstone: neither must leak into the caller's feed.
        session.add(
            Task(
                id=other_task_id,
                user_id=other.id,
                title="Other's task",
                revision=9,
                deleted_at=datetime.now(UTC),
            )
        )
        await session.flush()

    body = await _pull(client)

    assert _ids(body["tasks"]) == [mine["id"]]
    assert other_task_id not in _ids(body["tasks"])
    assert body["next_since"] == 1
