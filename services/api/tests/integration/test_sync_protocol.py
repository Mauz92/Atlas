"""Protocol negotiation, the instance sync block and the epoch (SYNC-03b, ADR-0059 D9/D12)."""

from __future__ import annotations

import uuid

import pytest
from httpx import AsyncClient

from atlas.auth.cli import _record_restore
from atlas.sync.protocol import PROTOCOL_MAX, PROTOCOL_MIN
from tests.conftest import create_user_via_setup, csrf_headers

pytestmark = pytest.mark.usefixtures("_db")


@pytest.fixture
async def authed(client: AsyncClient) -> AsyncClient:
    await create_user_via_setup(client)
    return client


async def _instance(c: AsyncClient) -> dict:
    r = await c.get("/api/instance")
    assert r.status_code == 200, r.text
    return r.json()


async def test_the_instance_advertises_the_sync_block(authed: AsyncClient) -> None:
    sync = (await _instance(authed))["sync"]
    assert sync["protocol"] == {"min": PROTOCOL_MIN, "max": PROTOCOL_MAX}
    assert set(sync["entities"]) == {
        "task",
        "project",
        "note",
        "note_project_link",
        "task_note_link",
    }
    assert sync["tombstone_retention_days"] == 90
    assert sync["idempotency_retention_days"] >= sync["tombstone_retention_days"]
    assert sync["limits"]["feed_page_max_with_data"] == 200
    assert uuid.UUID(sync["epoch"])


async def test_the_epoch_is_stable_between_reads(authed: AsyncClient) -> None:
    assert (await _instance(authed))["sync"]["epoch"] == (await _instance(authed))["sync"]["epoch"]


@pytest.mark.parametrize("value", ["1", " 1 "])
async def test_a_supported_protocol_is_accepted(authed: AsyncClient, value: str) -> None:
    r = await authed.get("/api/tasks", headers={"Atlas-Sync": value})
    assert r.status_code == 200


@pytest.mark.parametrize("value", ["0", "2", "99", "-1", "abc", "", "1.0", "1;2", "9" * 20])
async def test_an_unsupported_protocol_is_426_with_the_supported_range(
    authed: AsyncClient, value: str
) -> None:
    r = await authed.get("/api/tasks", headers={"Atlas-Sync": value})
    assert r.status_code == 426
    assert r.json() == {
        "error": "sync_version_unsupported",
        "detail": r.json()["detail"],
        "min": PROTOCOL_MIN,
        "max": PROTOCOL_MAX,
    }


async def test_a_write_with_an_unsupported_protocol_is_refused_before_anything_happens(
    authed: AsyncClient,
) -> None:
    r = await authed.post(
        "/api/tasks",
        json={"title": "t"},
        headers={**csrf_headers(authed), "Atlas-Sync": "2"},
    )
    assert r.status_code == 426
    assert (await authed.get("/api/tasks")).json()["tasks"] == []


async def test_the_version_check_comes_before_authentication(client: AsyncClient) -> None:
    assert (await client.get("/api/tasks", headers={"Atlas-Sync": "9"})).status_code == 426
    assert (await client.get("/api/tasks", headers={"Atlas-Sync": "1"})).status_code == 401
    assert (await client.get("/api/tasks")).status_code == 401


async def test_requests_without_the_header_are_unchanged(authed: AsyncClient) -> None:
    r = await authed.post("/api/tasks", json={"title": "t"}, headers=csrf_headers(authed))
    assert r.status_code == 201
    assert "error" not in r.json()


async def test_a_matching_epoch_is_accepted_and_a_missing_one_is_not_required(
    authed: AsyncClient,
) -> None:
    epoch = (await _instance(authed))["sync"]["epoch"]
    headers = {"Atlas-Sync": "1"}
    assert (await authed.get("/api/changes", headers=headers)).status_code == 200
    assert (
        await authed.get("/api/changes", headers={**headers, "Atlas-Epoch": epoch})
    ).status_code == 200


async def test_a_wrong_epoch_is_409_on_every_sync_capable_router(authed: AsyncClient) -> None:
    current = (await _instance(authed))["sync"]["epoch"]
    headers = {"Atlas-Sync": "1", "Atlas-Epoch": str(uuid.uuid4()), **csrf_headers(authed)}
    for method, path, body in (
        ("GET", "/api/changes", None),
        ("GET", "/api/tasks", None),
        ("POST", "/api/tasks", {"title": "x"}),
        ("POST", "/api/projects", {"name": "x"}),
        ("GET", "/api/notes", None),
    ):
        r = await authed.request(method, path, json=body, headers=headers)
        assert r.status_code == 409, (method, path, r.text)
        assert r.json()["error"] == "epoch_mismatch" and r.json()["epoch"] == current
    assert (await authed.get("/api/tasks")).json()["tasks"] == [], "nothing was applied"


async def test_the_epoch_header_is_ignored_outside_sync_mode(authed: AsyncClient) -> None:
    r = await authed.get("/api/tasks", headers={"Atlas-Epoch": str(uuid.uuid4())})
    assert r.status_code == 200


async def test_an_unauthenticated_caller_cannot_learn_the_epoch(client: AsyncClient) -> None:
    r = await client.get(
        "/api/changes", headers={"Atlas-Sync": "1", "Atlas-Epoch": str(uuid.uuid4())}
    )
    assert r.status_code == 401 and "epoch" not in r.text


async def test_recording_a_restore_rotates_the_epoch_and_stops_old_clients(
    authed: AsyncClient,
) -> None:
    old = (await _instance(authed))["sync"]["epoch"]
    assert await _record_restore() == 0
    new = (await _instance(authed))["sync"]["epoch"]
    assert new != old
    stale = await authed.get("/api/changes", headers={"Atlas-Sync": "1", "Atlas-Epoch": old})
    assert stale.status_code == 409 and stale.json()["epoch"] == new
    fresh = await authed.get("/api/changes", headers={"Atlas-Sync": "1", "Atlas-Epoch": new})
    assert fresh.status_code == 200
