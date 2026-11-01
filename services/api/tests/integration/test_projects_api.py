"""Projects API against a real PostgreSQL (M4-01).

Covers CRUD, soft deletion, revision-aware updates, idempotent mutations, boundary validation and
strict user scoping. These require a database (``client`` pulls in the ``_db`` fixture), so they are
reported ``BLOCKED`` when no PostgreSQL is reachable.
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from atlas.db import session_scope
from atlas.models import Project, User
from tests.conftest import create_user_via_setup, csrf_headers

if TYPE_CHECKING:
    from httpx import AsyncClient


async def _auth(client: AsyncClient) -> dict[str, str]:
    await create_user_via_setup(client)
    return csrf_headers(client)


async def _create_project(client: AsyncClient, headers: dict[str, str], **payload: object) -> dict:
    response = await client.post(
        "/api/projects", json={"name": "Project", **payload}, headers=headers
    )
    assert response.status_code == 201, response.text
    return response.json()


async def test_projects_require_authentication(client: AsyncClient) -> None:
    assert (await client.get("/api/projects")).status_code == 401
    assert (await client.post("/api/projects", json={"name": "x"})).status_code == 401


async def test_writes_require_csrf(client: AsyncClient) -> None:
    await create_user_via_setup(client)
    response = await client.post("/api/projects", json={"name": "x"})
    assert response.status_code == 403


async def test_create_read_and_list(client: AsyncClient) -> None:
    headers = await _auth(client)
    created = await client.post(
        "/api/projects",
        json={
            "name": "Launch",
            "description": "Ship M4",
            "status": "active",
            "start_date": "2026-11-01",
            "target_date": "2026-12-15",
        },
        headers=headers,
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["name"] == "Launch"
    assert body["description"] == "Ship M4"
    assert body["status"] == "active"
    assert body["start_date"] == "2026-11-01"
    assert body["target_date"] == "2026-12-15"
    assert body["revision"] == 1
    assert body["created_at"] is not None

    fetched = await client.get(f"/api/projects/{body['id']}")
    assert fetched.status_code == 200
    assert fetched.json()["id"] == body["id"]

    listing = await client.get("/api/projects")
    assert [project["id"] for project in listing.json()["projects"]] == [body["id"]]


async def test_patch_updates_fields_and_bumps_revision(client: AsyncClient) -> None:
    headers = await _auth(client)
    created = await _create_project(client, headers)

    updated = await client.patch(
        f"/api/projects/{created['id']}",
        json={"name": "Renamed", "status": "completed", "base_revision": created["revision"]},
        headers=headers,
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["name"] == "Renamed"
    assert updated.json()["status"] == "completed"
    assert updated.json()["revision"] == created["revision"] + 1


async def test_stale_base_revision_is_rejected_without_changing_state(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    created = await _create_project(client, headers)

    first = await client.patch(
        f"/api/projects/{created['id']}",
        json={"name": "First edit", "base_revision": created["revision"]},
        headers=headers,
    )
    assert first.status_code == 200

    stale = await client.patch(
        f"/api/projects/{created['id']}",
        json={"name": "Second edit", "base_revision": created["revision"]},
        headers=headers,
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["current_revision"] == created["revision"] + 1

    unchanged = await client.get(f"/api/projects/{created['id']}")
    assert unchanged.json()["name"] == "First edit"


async def test_create_is_idempotent_for_the_same_key(client: AsyncClient) -> None:
    headers = await _auth(client)
    key_headers = {**headers, "Idempotency-Key": "project-create-1"}
    payload = {"name": "Only once"}

    first = await client.post("/api/projects", json=payload, headers=key_headers)
    second = await client.post("/api/projects", json=payload, headers=key_headers)

    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json()["id"] == second.json()["id"]

    listing = (await client.get("/api/projects")).json()["projects"]
    assert len(listing) == 1


async def test_reusing_a_key_with_a_different_payload_is_rejected(client: AsyncClient) -> None:
    headers = await _auth(client)
    key_headers = {**headers, "Idempotency-Key": "project-reuse-1"}

    first = await client.post("/api/projects", json={"name": "first"}, headers=key_headers)
    assert first.status_code == 201

    conflict = await client.post("/api/projects", json={"name": "second"}, headers=key_headers)
    assert conflict.status_code == 409

    listing = (await client.get("/api/projects")).json()["projects"]
    assert [project["name"] for project in listing] == ["first"]


async def test_delete_is_soft_and_hides_the_project(client: AsyncClient) -> None:
    headers = await _auth(client)
    created = await _create_project(client, headers)

    assert (
        await client.delete(f"/api/projects/{created['id']}", headers=headers)
    ).status_code == 204
    assert (await client.get(f"/api/projects/{created['id']}")).status_code == 404
    assert (await client.get("/api/projects")).json()["projects"] == []
    # A second delete without a key is a plain 404.
    assert (
        await client.delete(f"/api/projects/{created['id']}", headers=headers)
    ).status_code == 404


async def test_delete_with_an_idempotency_key_replays(client: AsyncClient) -> None:
    headers = await _auth(client)
    created = await _create_project(client, headers)
    key_headers = {**headers, "Idempotency-Key": "project-delete-1"}

    first = await client.delete(f"/api/projects/{created['id']}", headers=key_headers)
    assert first.status_code == 204
    replay = await client.delete(f"/api/projects/{created['id']}", headers=key_headers)
    assert replay.status_code == 204


async def test_validation_errors_are_rejected_without_side_effects(client: AsyncClient) -> None:
    headers = await _auth(client)
    existing = await _create_project(client, headers, name="Kept")
    before = (await client.get("/api/projects")).json()

    # An empty name and an unknown status are rejected at the boundary.
    bad_name = await client.post("/api/projects", json={"name": ""}, headers=headers)
    assert bad_name.status_code == 422
    bad_status = await client.post(
        "/api/projects", json={"name": "x", "status": "someday"}, headers=headers
    )
    assert bad_status.status_code == 422
    # A malformed date is rejected at the boundary.
    bad_date = await client.post(
        "/api/projects", json={"name": "x", "start_date": "not-a-date"}, headers=headers
    )
    assert bad_date.status_code == 422
    # An inverted date range is rejected by the service.
    inverted = await client.post(
        "/api/projects",
        json={"name": "x", "start_date": "2026-12-01", "target_date": "2026-11-01"},
        headers=headers,
    )
    assert inverted.status_code == 400

    after = (await client.get("/api/projects")).json()
    assert after == before
    assert [project["id"] for project in after["projects"]] == [existing["id"]]


async def test_an_update_cannot_store_an_inverted_date_range(client: AsyncClient) -> None:
    headers = await _auth(client)
    created = await _create_project(
        client, headers, start_date="2026-11-01", target_date="2026-12-01"
    )

    response = await client.patch(
        f"/api/projects/{created['id']}",
        json={"target_date": "2026-10-01"},
        headers=headers,
    )
    assert response.status_code == 400

    unchanged = (await client.get(f"/api/projects/{created['id']}")).json()
    assert unchanged["target_date"] == "2026-12-01"
    assert unchanged["revision"] == created["revision"]


async def test_projects_are_strictly_user_scoped(client: AsyncClient) -> None:
    headers = await _auth(client)
    mine = await _create_project(client, headers, name="Mine")

    other_project_id = uuid.uuid4()
    async with session_scope() as session:
        other = User(
            id=uuid.uuid4(),
            email=f"{uuid.uuid4()}@example.com",
            display_name="Other",
            password_hash="not-used",
        )
        session.add(other)
        await session.flush()
        session.add(Project(id=other_project_id, user_id=other.id, name="Other's project"))
        await session.flush()

    # The other user's project is invisible: read, update and delete all report 404.
    assert (await client.get(f"/api/projects/{other_project_id}")).status_code == 404
    assert (
        await client.patch(
            f"/api/projects/{other_project_id}", json={"name": "hijacked"}, headers=headers
        )
    ).status_code == 404
    assert (
        await client.delete(f"/api/projects/{other_project_id}", headers=headers)
    ).status_code == 404

    listing = (await client.get("/api/projects")).json()["projects"]
    assert [project["id"] for project in listing] == [mine["id"]]
