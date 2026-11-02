"""Tasks API against a real PostgreSQL (M3-02).

Covers CRUD, soft deletion, revision-aware updates and idempotent mutations. These require a
database (``client`` pulls in the ``_db`` fixture), so they are reported ``BLOCKED`` when no
PostgreSQL is reachable.
"""

from __future__ import annotations

import uuid

from httpx import AsyncClient

from tests.conftest import create_user_via_setup, csrf_headers


async def _auth(client: AsyncClient) -> dict[str, str]:
    await create_user_via_setup(client)
    return csrf_headers(client)


async def test_tasks_require_authentication(client: AsyncClient) -> None:
    assert (await client.get("/api/tasks")).status_code == 401
    assert (await client.post("/api/tasks", json={"title": "x"})).status_code == 401


async def test_writes_require_csrf(client: AsyncClient) -> None:
    await create_user_via_setup(client)
    response = await client.post("/api/tasks", json={"title": "x"})
    assert response.status_code == 403


async def test_create_read_and_list(client: AsyncClient) -> None:
    headers = await _auth(client)
    created = await client.post(
        "/api/tasks",
        json={"title": "Write spec", "priority": "high", "due_at": "2026-01-02T09:30:00Z"},
        headers=headers,
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["title"] == "Write spec"
    assert body["status"] == "inbox"
    assert body["priority"] == "high"
    assert body["revision"] == 1
    assert body["due_at"] is not None

    fetched = await client.get(f"/api/tasks/{body['id']}")
    assert fetched.status_code == 200
    assert fetched.json()["id"] == body["id"]

    listing = await client.get("/api/tasks")
    assert [task["id"] for task in listing.json()["tasks"]] == [body["id"]]


async def test_invalid_priority_is_rejected(client: AsyncClient) -> None:
    headers = await _auth(client)
    response = await client.post(
        "/api/tasks", json={"title": "x", "priority": "someday"}, headers=headers
    )
    assert response.status_code == 422


async def test_parent_task_must_exist(client: AsyncClient) -> None:
    headers = await _auth(client)
    response = await client.post(
        "/api/tasks",
        json={"title": "child", "parent_task_id": str(uuid.uuid4())},
        headers=headers,
    )
    assert response.status_code == 400


async def test_update_bumps_revision_and_detects_stale_writes(client: AsyncClient) -> None:
    headers = await _auth(client)
    created = (await client.post("/api/tasks", json={"title": "T"}, headers=headers)).json()

    updated = await client.patch(
        f"/api/tasks/{created['id']}",
        json={"title": "T2", "base_revision": created["revision"]},
        headers=headers,
    )
    assert updated.status_code == 200
    assert updated.json()["revision"] == created["revision"] + 1
    assert updated.json()["title"] == "T2"

    stale = await client.patch(
        f"/api/tasks/{created['id']}",
        json={"title": "T3", "base_revision": created["revision"]},
        headers=headers,
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["current_revision"] == created["revision"] + 1

    unchanged = await client.get(f"/api/tasks/{created['id']}")
    assert unchanged.json()["title"] == "T2"


async def test_create_is_idempotent_for_the_same_key(client: AsyncClient) -> None:
    headers = await _auth(client)
    key_headers = {**headers, "Idempotency-Key": "create-1"}
    payload = {"title": "Only once"}

    first = await client.post("/api/tasks", json=payload, headers=key_headers)
    second = await client.post("/api/tasks", json=payload, headers=key_headers)

    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json()["id"] == second.json()["id"]

    listing = (await client.get("/api/tasks")).json()["tasks"]
    assert len(listing) == 1


async def test_reusing_a_key_with_a_different_payload_is_rejected(client: AsyncClient) -> None:
    headers = await _auth(client)
    key_headers = {**headers, "Idempotency-Key": "reuse-1"}

    first = await client.post("/api/tasks", json={"title": "first"}, headers=key_headers)
    assert first.status_code == 201

    conflict = await client.post("/api/tasks", json={"title": "second"}, headers=key_headers)
    assert conflict.status_code == 409

    listing = (await client.get("/api/tasks")).json()["tasks"]
    assert [task["title"] for task in listing] == ["first"]


async def test_delete_is_soft_and_hides_the_task(client: AsyncClient) -> None:
    headers = await _auth(client)
    created = (await client.post("/api/tasks", json={"title": "Doomed"}, headers=headers)).json()

    assert (await client.delete(f"/api/tasks/{created['id']}", headers=headers)).status_code == 204
    assert (await client.get(f"/api/tasks/{created['id']}")).status_code == 404
    assert (await client.get("/api/tasks")).json()["tasks"] == []
    # A second delete without a key is a plain 404.
    assert (await client.delete(f"/api/tasks/{created['id']}", headers=headers)).status_code == 404


async def test_delete_with_an_idempotency_key_replays(client: AsyncClient) -> None:
    headers = await _auth(client)
    created = (await client.post("/api/tasks", json={"title": "Doomed"}, headers=headers)).json()
    key_headers = {**headers, "Idempotency-Key": "delete-1"}

    first = await client.delete(f"/api/tasks/{created['id']}", headers=key_headers)
    assert first.status_code == 204

    replay = await client.delete(f"/api/tasks/{created['id']}", headers=key_headers)
    assert replay.status_code == 204


async def _create_task(client: AsyncClient, headers: dict[str, str], **payload: object) -> dict:
    response = await client.post("/api/tasks", json={"title": "T", **payload}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


async def test_completing_a_task_sets_completed_at_and_reopening_clears_it(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    task = await _create_task(client, headers)

    completed = await client.patch(
        f"/api/tasks/{task['id']}", json={"status": "completed"}, headers=headers
    )
    assert completed.status_code == 200
    assert completed.json()["status"] == "completed"
    assert completed.json()["completed_at"] is not None

    reopened = await client.patch(
        f"/api/tasks/{task['id']}", json={"status": "in_progress"}, headers=headers
    )
    assert reopened.status_code == 200
    assert reopened.json()["completed_at"] is None


async def test_creating_a_completed_task_records_completed_at(client: AsyncClient) -> None:
    headers = await _auth(client)
    task = await _create_task(client, headers, status="completed")
    assert task["status"] == "completed"
    assert task["completed_at"] is not None


async def test_invalid_status_transition_is_rejected(client: AsyncClient) -> None:
    headers = await _auth(client)
    task = await _create_task(client, headers)
    completed = await client.patch(
        f"/api/tasks/{task['id']}", json={"status": "completed"}, headers=headers
    )
    assert completed.status_code == 200

    rejected = await client.patch(
        f"/api/tasks/{task['id']}", json={"status": "inbox"}, headers=headers
    )
    assert rejected.status_code == 409
    assert rejected.json()["detail"]["current"] == "completed"
    assert rejected.json()["detail"]["requested"] == "inbox"

    unchanged = await client.get(f"/api/tasks/{task['id']}")
    assert unchanged.json()["status"] == "completed"


async def test_self_transition_is_rejected(client: AsyncClient) -> None:
    headers = await _auth(client)
    task = await _create_task(client, headers)
    response = await client.patch(
        f"/api/tasks/{task['id']}", json={"status": "inbox"}, headers=headers
    )
    assert response.status_code == 409


async def test_an_archived_task_cannot_be_completed(client: AsyncClient) -> None:
    headers = await _auth(client)
    task = await _create_task(client, headers)
    archived = await client.patch(
        f"/api/tasks/{task['id']}", json={"status": "archived"}, headers=headers
    )
    assert archived.status_code == 200

    response = await client.patch(
        f"/api/tasks/{task['id']}", json={"status": "completed"}, headers=headers
    )
    assert response.status_code == 409


async def test_a_naive_due_date_is_interpreted_in_the_tasks_time_zone(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    task = await _create_task(
        client, headers, time_zone="Europe/Amsterdam", due_at="2026-01-02T09:30:00"
    )
    # 09:30 CET == 08:30 UTC.
    assert task["due_at"].startswith("2026-01-02T08:30:00")


async def test_updating_a_due_date_uses_the_stored_time_zone(client: AsyncClient) -> None:
    headers = await _auth(client)
    task = await _create_task(client, headers, time_zone="Europe/Amsterdam")

    updated = await client.patch(
        f"/api/tasks/{task['id']}", json={"due_at": "2026-07-02T09:30:00"}, headers=headers
    )
    assert updated.status_code == 200
    # 09:30 CEST == 07:30 UTC.
    assert updated.json()["due_at"].startswith("2026-07-02T07:30:00")


async def test_an_unknown_time_zone_is_rejected(client: AsyncClient) -> None:
    headers = await _auth(client)
    response = await client.post(
        "/api/tasks", json={"title": "x", "time_zone": "Mars/Phobos"}, headers=headers
    )
    assert response.status_code == 422


async def test_a_due_date_in_the_dst_gap_is_rejected(client: AsyncClient) -> None:
    headers = await _auth(client)
    response = await client.post(
        "/api/tasks",
        json={"title": "x", "time_zone": "Europe/Amsterdam", "due_at": "2026-03-29T02:30:00"},
        headers=headers,
    )
    assert response.status_code == 400


async def test_tags_are_set_replaced_and_listed(client: AsyncClient) -> None:
    headers = await _auth(client)
    created = await _create_task(client, headers, tags=["Home", "  #errands ", "home"])
    # Trimmed, '#' stripped and de-duplicated case-insensitively; returned sorted.
    assert created["tags"] == ["errands", "Home"]

    replaced = await client.patch(
        f"/api/tasks/{created['id']}",
        json={"tags": ["work"], "base_revision": created["revision"]},
        headers=headers,
    )
    assert replaced.status_code == 200, replaced.text
    assert replaced.json()["tags"] == ["work"]

    # Omitting `tags` leaves them alone; an empty list clears them.
    untouched = await client.patch(
        f"/api/tasks/{created['id']}", json={"title": "Renamed"}, headers=headers
    )
    assert untouched.json()["tags"] == ["work"]
    cleared = await client.patch(f"/api/tasks/{created['id']}", json={"tags": []}, headers=headers)
    assert cleared.json()["tags"] == []

    # An existing tag is matched case-insensitively and keeps its original spelling.
    await client.patch(f"/api/tasks/{created['id']}", json={"tags": ["Work"]}, headers=headers)
    listing = (await client.get("/api/tasks")).json()["tasks"]
    assert listing[0]["tags"] == ["work"]
    assert (await client.get(f"/api/tasks/{created['id']}")).json()["tags"] == ["work"]


async def test_invalid_tags_are_rejected_without_side_effects(client: AsyncClient) -> None:
    headers = await _auth(client)
    too_long = await client.post(
        "/api/tasks", json={"title": "x", "tags": ["a" * 65]}, headers=headers
    )
    assert too_long.status_code == 422
    too_many = await client.post(
        "/api/tasks", json={"title": "x", "tags": [f"t{n}" for n in range(21)]}, headers=headers
    )
    assert too_many.status_code == 422
    assert (await client.get("/api/tasks")).json()["tasks"] == []


async def test_tags_are_user_scoped(client: AsyncClient) -> None:
    headers = await _auth(client)
    task = await _create_task(client, headers, tags=["private"])
    assert task["tags"] == ["private"]
    # Another user's task id is not reachable, so its tags cannot be read or changed.
    other = await client.patch(f"/api/tasks/{uuid.uuid4()}", json={"tags": ["x"]}, headers=headers)
    assert other.status_code == 404


async def test_restore_undoes_a_delete(client: AsyncClient) -> None:
    headers = await _auth(client)
    created = await _create_task(client, headers, tags=["keep"], priority="high")
    assert (await client.delete(f"/api/tasks/{created['id']}", headers=headers)).status_code == 204
    assert (await client.get(f"/api/tasks/{created['id']}")).status_code == 404

    restored = await client.post(f"/api/tasks/{created['id']}/restore", headers=headers)
    assert restored.status_code == 200, restored.text
    body = restored.json()
    assert body["id"] == created["id"]
    assert body["priority"] == "high"
    assert body["tags"] == ["keep"]
    assert body["revision"] > created["revision"]
    assert [t["id"] for t in (await client.get("/api/tasks")).json()["tasks"]] == [created["id"]]

    # A task that is not deleted cannot be "restored", and an unknown id is a 404 too.
    assert (
        await client.post(f"/api/tasks/{created['id']}/restore", headers=headers)
    ).status_code == 404
    assert (
        await client.post(f"/api/tasks/{uuid.uuid4()}/restore", headers=headers)
    ).status_code == 404


async def test_restore_with_an_idempotency_key_replays(client: AsyncClient) -> None:
    headers = await _auth(client)
    created = await _create_task(client, headers)
    await client.delete(f"/api/tasks/{created['id']}", headers=headers)
    key_headers = {**headers, "Idempotency-Key": "restore-1"}

    first = await client.post(f"/api/tasks/{created['id']}/restore", headers=key_headers)
    replay = await client.post(f"/api/tasks/{created['id']}/restore", headers=key_headers)
    assert first.status_code == replay.status_code == 200
    assert first.json() == replay.json()


async def test_restore_appears_in_the_change_feed(client: AsyncClient) -> None:
    headers = await _auth(client)
    created = await _create_task(client, headers)
    await client.delete(f"/api/tasks/{created['id']}", headers=headers)
    await client.post(f"/api/tasks/{created['id']}/restore", headers=headers)
    feed = (await client.get("/api/tasks/changes")).json()
    (item,) = [t for t in feed["tasks"] if t["id"] == created["id"]]
    assert item["deleted_at"] is None
