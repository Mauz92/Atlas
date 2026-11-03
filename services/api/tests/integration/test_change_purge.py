"""Change-feed retention: purge, purge floor and resync (M7-02) against a real PostgreSQL.

Covers the acceptance criteria: a delete is visible within retention; the purge removes only old
deletion tombstones (SYNC-03e, ADR-0059 D2: upserts are kept, never a user's entity rows) and is
idempotent; a cursor that predates the floor gets ``resync_required`` instead of a partial feed
while ``since=0`` is always served as a snapshot; a purged deletion is never re-reported as live;
the purge runs on the durable queue and re-schedules (including reaping a stale restart) and also
expires idempotency keys; and the floor is strictly user-scoped. Needs a database (``_db``).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, update

from atlas.auth import hash_password
from atlas.changes import ChangePurgeService
from atlas.db import session_scope
from atlas.jobs import CHANGE_PURGE_TASK, ensure_change_purge_job, queue, worker
from atlas.models import ChangeLog, IdempotencyKey, Job, Task, User
from tests.conftest import create_user_via_setup, csrf_headers

pytestmark = pytest.mark.usefixtures("_db")

#: Comfortably older than the (default 90-day) retention window; uses no fixed clock.
_AGE = timedelta(days=200)


def _cutoff() -> datetime:
    return datetime.now(UTC) - timedelta(days=90)


def _aged() -> datetime:
    return datetime.now(UTC) - _AGE


async def _auth(client: AsyncClient) -> dict[str, str]:
    await create_user_via_setup(client)
    return csrf_headers(client)


async def _pull(client: AsyncClient, *, since: object = None, limit: object = None) -> dict:
    params = {
        key: value for key, value in (("since", since), ("limit", limit)) if value is not None
    }
    response = await client.get("/api/changes", params=params)
    assert response.status_code == 200, response.text
    body = response.json()
    assert {"changes", "since", "next_since", "has_more", "resync_required"} <= set(body)
    return body


async def _create_task(client: AsyncClient, headers: dict[str, str], title: str = "T") -> dict:
    response = await client.post("/api/tasks", json={"title": title}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


def _operations(changes: list[dict]) -> dict[tuple[str, str], str]:
    return {(change["entity_type"], change["entity_id"]): change["operation"] for change in changes}


async def _owner_id(email: str = "owner@example.com") -> uuid.UUID:
    async with session_scope() as session:
        user_id = await session.scalar(select(User.id).where(User.email == email))
    assert user_id is not None
    return user_id


async def _age_change_log(user_id: uuid.UUID, *, entity_id: str | None = None) -> None:
    """Backdate the user's change row(s) so the purge sees them as older than the window."""
    async with session_scope() as session:
        statement = update(ChangeLog).where(ChangeLog.user_id == user_id)
        if entity_id is not None:
            statement = statement.where(ChangeLog.entity_id == entity_id)
        await session.execute(statement.values(changed_at=_aged()))


async def _purge(*, cutoff: datetime | None = None):
    async with session_scope() as session:
        return await ChangePurgeService(session).purge(cutoff=cutoff or _cutoff())


async def _floor(user_id: uuid.UUID) -> int:
    async with session_scope() as session:
        return int(await session.scalar(select(User.change_purge_floor).where(User.id == user_id)))


# --- a delete is visible while within retention -------------------------------


async def test_a_delete_is_visible_within_retention_and_the_purge_keeps_it(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    task = await _create_task(client, headers, title="Draft")
    assert (await client.delete(f"/api/tasks/{task['id']}", headers=headers)).status_code == 204

    # A purge over the normal window removes nothing (the tombstone is recent).
    summary = await _purge()
    assert summary.purged == 0

    # The create is cursor 1, the delete cursor 2: a client that holds cursor 1 sees the deletion.
    feed = await _pull(client, since=1)
    assert feed["resync_required"] is False
    assert _operations(feed["changes"])[("task", task["id"])] == "delete"
    # A snapshot (since=0) carries no tombstone: a client with no state has nothing to delete.
    assert _operations((await _pull(client))["changes"]) == {}


# --- the purge bounds only the feed history -----------------------------------


async def test_the_purge_removes_only_old_tombstones_never_upserts_or_entity_rows(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    old_task = await _create_task(client, headers, title="Old")  # cursor 1
    new_task = await _create_task(client, headers, title="New")  # cursor 2
    recent = await _create_task(client, headers, title="Recent")  # cursor 3
    for task in (old_task, recent):
        assert (await client.delete(f"/api/tasks/{task['id']}", headers=headers)).status_code == 204
    # old_task's tombstone is cursor 4, recent's is cursor 5
    user_id = await _owner_id()
    await _age_change_log(user_id, entity_id=old_task["id"])
    await _age_change_log(user_id, entity_id=new_task["id"])  # an old *upsert* must survive

    summary = await _purge()
    assert summary.purged == 1
    assert summary.users_advanced == 1

    async with session_scope() as session:
        rows = (await session.scalars(select(ChangeLog).where(ChangeLog.user_id == user_id))).all()
        assert {(row.entity_id, row.operation) for row in rows} == {
            (new_task["id"], "upsert"),
            (recent["id"], "delete"),
        }
        # The user's entity rows are untouched: all three tasks still exist.
        tasks = (await session.scalars(select(Task).where(Task.user_id == user_id))).all()
        assert {str(task.id) for task in tasks} == {old_task["id"], new_task["id"], recent["id"]}
    # The floor advanced to exactly the purged tombstone's cursor.
    assert await _floor(user_id) == 4

    # Idempotent: a second pass over the same window removes nothing and does not move the floor.
    again = await _purge()
    assert again.purged == 0
    assert again.users_advanced == 0
    assert await _floor(user_id) == 4


# --- the resync signal for a stale client -------------------------------------


async def test_a_cursor_that_predates_the_floor_gets_resync_required(client: AsyncClient) -> None:
    headers = await _auth(client)
    first = await _create_task(client, headers, title="First")  # cursor 1
    second = await _create_task(client, headers, title="Second")  # cursor 2
    assert (await client.delete(f"/api/tasks/{first['id']}", headers=headers)).status_code == 204
    user_id = await _owner_id()  # first's tombstone is cursor 3
    await _age_change_log(user_id, entity_id=first["id"])
    await _purge()
    assert await _floor(user_id) == 3

    # since=1 predates the floor (3): the purged deletion can never be delivered, so resync.
    stale = await _pull(client, since=1)
    assert stale["resync_required"] is True
    assert stale["resync_reason"] == "below_floor"
    assert stale["changes"] == []
    assert stale["next_since"] == 3  # the current high-water mark to resume from after resync
    assert stale["floor"] == 3 and stale["head"] == 3

    # since=0 is a snapshot and is always served, whatever was purged.
    snapshot = await _pull(client, since=0)
    assert snapshot["resync_required"] is False
    assert [(c["entity_type"], c["entity_id"]) for c in snapshot["changes"]] == [
        ("task", second["id"])
    ]

    # A cursor at the floor is served normally: every tombstone after it is still retained.
    fresh = await _pull(client, since=3)
    assert fresh["resync_required"] is False and fresh["changes"] == []


# --- no resurrection ----------------------------------------------------------


async def test_a_purged_deletion_is_never_reported_as_live(client: AsyncClient) -> None:
    headers = await _auth(client)
    task = await _create_task(client, headers, title="Doomed")  # cursor 1
    assert (await client.delete(f"/api/tasks/{task['id']}", headers=headers)).status_code == 204
    user_id = await _owner_id()
    await _age_change_log(user_id)  # the single tombstone row (cursor 2) is now old
    summary = await _purge()
    assert summary.purged == 1

    # A client that held cursor 1 is never handed a partial feed that hides the deletion ...
    stale = await _pull(client, since=1)
    assert stale["resync_required"] is True and stale["changes"] == []
    # ... and a new device's snapshot never lists the deleted task as live.
    snapshot = await _pull(client, since=0)
    assert snapshot["resync_required"] is False and snapshot["changes"] == []

    # The entity itself is still a tombstone, and the ordinary list does not present it as live.
    async with session_scope() as session:
        stored = await session.get(Task, uuid.UUID(task["id"]))
        assert stored is not None
        assert stored.deleted_at is not None
    listed = await client.get("/api/tasks")
    assert listed.status_code == 200
    assert task["id"] not in {item["id"] for item in listed.json()["tasks"]}


# --- the durable purge job ----------------------------------------------------


async def test_the_purge_job_runs_on_the_queue_and_reschedules(client: AsyncClient) -> None:
    headers = await _auth(client)
    task = await _create_task(client, headers, title="Old")
    assert (await client.delete(f"/api/tasks/{task['id']}", headers=headers)).status_code == 204
    user_id = await _owner_id()
    await _age_change_log(user_id, entity_id=task["id"])
    # an old and a recent idempotency key: only the old one may go
    async with session_scope() as session:
        for key, age in (("old-key", _AGE), ("new-key", timedelta(days=1))):
            session.add(
                IdempotencyKey(
                    user_id=user_id,
                    key=key,
                    operation="task.create",
                    request_hash="h",
                    response_status=201,
                    response_body={},
                    created_at=datetime.now(UTC) - age,
                )
            )

    async with session_scope() as session:
        await ensure_change_purge_job(session)

    async with session_scope() as session:
        queued = (
            await session.scalars(select(Job).where(Job.task_name == CHANGE_PURGE_TASK))
        ).all()
        assert [job.status for job in queued] == ["pending"]

    # The durable worker picks the job up and runs the purge handler.
    assert await worker.run_once("worker-1") is True

    async with session_scope() as session:
        jobs = (
            await session.scalars(
                select(Job).where(Job.task_name == CHANGE_PURGE_TASK).order_by(Job.created_at)
            )
        ).all()
    statuses = [job.status for job in jobs]
    assert "succeeded" in statuses
    pending = [job for job in jobs if job.status == "pending"]
    assert len(pending) == 1  # the chain re-scheduled itself
    assert pending[0].run_at > datetime.now(UTC)

    # The handler actually bounded the feed history and expired the old idempotency key only.
    assert await _floor(user_id) == 2
    async with session_scope() as session:
        keys = set(await session.scalars(select(IdempotencyKey.key)))
    assert keys == {"new-key"}


async def test_a_stale_running_purge_is_reaped_and_restarted() -> None:
    async with session_scope() as session:
        job = await queue.enqueue(session, CHANGE_PURGE_TASK)
        job.status = "running"
        job.locked_by = "dead-worker"
        job.locked_at = datetime.now(UTC) - timedelta(hours=2)
        await session.flush()

    async with session_scope() as session:
        await ensure_change_purge_job(session)

    async with session_scope() as session:
        jobs = (await session.scalars(select(Job).where(Job.task_name == CHANGE_PURGE_TASK))).all()
        assert sorted(job.status for job in jobs) == ["failed", "pending"]


# --- strict user scoping ------------------------------------------------------


async def test_the_purge_floor_is_strictly_user_scoped(client: AsyncClient, app: FastAPI) -> None:
    headers = await _auth(client)
    mine = await _create_task(client, headers, title="Mine")
    assert (await client.delete(f"/api/tasks/{mine['id']}", headers=headers)).status_code == 204
    await _age_change_log(await _owner_id(), entity_id=mine["id"])
    await _purge()
    assert await _floor(await _owner_id()) == 2

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
        await _create_task(other, other_headers, title="Theirs")

        # The other user is unaffected: floor 0, and their feed is served, not resynced.
        assert await _floor(await _owner_id(other_email)) == 0
        their_feed = await _pull(other, since=0)
        assert their_feed["resync_required"] is False
        assert len(their_feed["changes"]) == 1

    # And the first user still sees the resync signal for their own purged cursor.
    assert (await _pull(client, since=1))["resync_required"] is True
