"""Reminder timing preferences over HTTP against a real PostgreSQL (M8-05).

Covers the acceptance criteria: a user can read and change their reminder timing; a change persists
and **reschedules** the durable reminder (a later timing fires later, an earlier one earlier) by
reusing the M8-01 machinery; invalid values are rejected at the boundary with no side effects; the
API is strictly user-scoped; and a per-entity override beats the default. Needs a database.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, time

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select

from atlas.db import session_scope
from atlas.models import Job, Reminder, ReminderPolicy, ReminderStatus, Task, User
from tests.conftest import create_user_via_setup, csrf_headers

pytestmark = pytest.mark.usefixtures("_db")

#: A future due date whose reminder can be computed deterministically (no wall-clock dependence).
_DUE = datetime(2026, 6, 10, 15, 0, tzinfo=UTC)  # 17:00 Europe/Amsterdam (CEST)
#: 09:00 local on the due day / the day before, in UTC.
_DUE_9AM = datetime(2026, 6, 10, 7, 0, tzinfo=UTC)
_DAY_BEFORE_9AM = datetime(2026, 6, 9, 7, 0, tzinfo=UTC)
#: 16:00 local on the due day (later than the 09:00 default).
_DUE_4PM = datetime(2026, 6, 10, 14, 0, tzinfo=UTC)


async def _auth(client: AsyncClient) -> dict[str, str]:
    await create_user_via_setup(client)
    return csrf_headers(client)


async def _owner_id() -> uuid.UUID:
    async with session_scope() as session:
        return (await session.execute(select(User))).scalars().one().id


async def _seed_task(
    user_id: uuid.UUID, *, due_at: datetime = _DUE, policy: uuid.UUID | None = None
) -> uuid.UUID:
    async with session_scope() as session:
        task = Task(
            user_id=user_id,
            title="Water the plants",
            status="inbox",
            due_at=due_at,
            time_zone="Europe/Amsterdam",
            reminder_policy_id=policy,
        )
        session.add(task)
        await session.flush()
        return task.id


async def _reminder(task_id: uuid.UUID) -> Reminder | None:
    async with session_scope() as session:
        return await session.scalar(select(Reminder).where(Reminder.entity_id == task_id))


async def _policy_count(user_id: uuid.UUID) -> int:
    async with session_scope() as session:
        return await session.scalar(
            select(func.count())
            .select_from(ReminderPolicy)
            .where(ReminderPolicy.user_id == user_id)
        )


async def _delivery_jobs(reminder_id: uuid.UUID) -> list[Job]:
    async with session_scope() as session:
        rows = await session.scalars(
            select(Job).where(Job.idempotency_key.like(f"reminder.deliver:{reminder_id}:%"))
        )
        return list(rows)


async def _set_default(
    client: AsyncClient,
    headers: dict[str, str],
    *,
    days_before: int,
    at_time: str,
) -> None:
    response = await client.put(
        "/api/notifications/reminders",
        json={"default": {"days_before": days_before, "at_time": at_time}},
        headers=headers,
    )
    assert response.status_code == 200, response.text


# --- authentication and CSRF --------------------------------------------------


async def test_reminder_preferences_require_authentication(client: AsyncClient) -> None:
    assert (await client.get("/api/notifications/reminders")).status_code == 401
    assert (
        await client.put("/api/notifications/reminders", json={"default": None})
    ).status_code == 401
    assert (await client.get(f"/api/tasks/{uuid.uuid4()}/reminder")).status_code == 401
    assert (
        await client.put(f"/api/tasks/{uuid.uuid4()}/reminder", json={"timing": None})
    ).status_code == 401


async def test_writes_require_csrf(client: AsyncClient) -> None:
    await create_user_via_setup(client)
    response = await client.put(
        "/api/notifications/reminders",
        json={"default": {"days_before": 1, "at_time": "09:00"}},
    )
    assert response.status_code == 403


# --- the per-user default -----------------------------------------------------


async def test_the_default_is_null_until_set_then_reads_back(client: AsyncClient) -> None:
    headers = await _auth(client)
    empty = await client.get("/api/notifications/reminders")
    assert empty.status_code == 200
    assert empty.json() == {"default": None}

    await _set_default(client, headers, days_before=2, at_time="08:30")
    read_back = await client.get("/api/notifications/reminders")
    assert read_back.json() == {"default": {"days_before": 2, "at_time": "08:30"}}


async def test_setting_the_default_reschedules_inherited_tasks(client: AsyncClient) -> None:
    headers = await _auth(client)
    owner = await _owner_id()
    task_id = await _seed_task(owner)

    # No default yet: the task inherits nothing, so it has no reminder.
    assert await _reminder(task_id) is None

    # A default materialises the reminder at 09:00 local on the due day...
    await _set_default(client, headers, days_before=0, at_time="09:00")
    reminder = await _reminder(task_id)
    assert reminder is not None and reminder.remind_at == _DUE_9AM
    assert reminder.status == ReminderStatus.SCHEDULED.value
    jobs = await _delivery_jobs(reminder.id)
    assert [job.run_at for job in jobs] == [_DUE_9AM]

    # A later timing moves the durable reminder later (same row, new instant, new job)...
    await _set_default(client, headers, days_before=0, at_time="16:00")
    moved = await _reminder(task_id)
    assert moved is not None and moved.id == reminder.id
    assert moved.remind_at == _DUE_4PM
    assert _DUE_4PM in {job.run_at for job in await _delivery_jobs(reminder.id)}

    # ...and an earlier one moves it earlier.
    await _set_default(client, headers, days_before=1, at_time="09:00")
    earlier = await _reminder(task_id)
    assert earlier is not None and earlier.remind_at == _DAY_BEFORE_9AM
    assert _DAY_BEFORE_9AM in {job.run_at for job in await _delivery_jobs(reminder.id)}


async def test_setting_the_default_is_idempotent(client: AsyncClient) -> None:
    headers = await _auth(client)
    owner = await _owner_id()
    await _seed_task(owner)

    await _set_default(client, headers, days_before=1, at_time="07:00")
    await _set_default(client, headers, days_before=1, at_time="07:00")

    # One default policy and one reminder — a repeated save changes nothing (AGENTS.md §9).
    assert await _policy_count(owner) == 1
    async with session_scope() as session:
        reminder_count = await session.scalar(select(func.count()).select_from(Reminder))
    assert reminder_count == 1


async def test_clearing_the_default_cancels_inherited_reminders(client: AsyncClient) -> None:
    headers = await _auth(client)
    owner = await _owner_id()
    task_id = await _seed_task(owner)
    await _set_default(client, headers, days_before=0, at_time="09:00")
    assert (await _reminder(task_id)) is not None

    cleared = await client.put(
        "/api/notifications/reminders", json={"default": None}, headers=headers
    )
    assert cleared.status_code == 200
    assert cleared.json() == {"default": None}
    assert await _policy_count(owner) == 0
    reminder = await _reminder(task_id)
    assert reminder is not None and reminder.status == ReminderStatus.CANCELLED.value

    # Clearing again is a no-op.
    assert (
        await client.put("/api/notifications/reminders", json={"default": None}, headers=headers)
    ).status_code == 200


@pytest.mark.parametrize(
    "payload",
    [
        {"default": {"days_before": -1, "at_time": "09:00"}},
        {"default": {"days_before": 31, "at_time": "09:00"}},
        {"default": {"days_before": 1, "at_time": "9:00"}},
        {"default": {"days_before": 1, "at_time": "24:00"}},
        {"default": {"days_before": 1, "at_time": "nope"}},
    ],
)
async def test_an_invalid_timing_is_rejected_with_no_side_effects(
    client: AsyncClient, payload: dict[str, object]
) -> None:
    headers = await _auth(client)
    owner = await _owner_id()
    task_id = await _seed_task(owner)

    response = await client.put("/api/notifications/reminders", json=payload, headers=headers)
    assert response.status_code == 422, response.text
    # No policy, no reminder: the boundary rejected it before any write.
    assert await _policy_count(owner) == 0
    assert await _reminder(task_id) is None


async def test_preferences_are_strictly_user_scoped(client: AsyncClient) -> None:
    headers = await _auth(client)
    await _set_default(client, headers, days_before=1, at_time="09:00")

    async with session_scope() as session:
        other = User(
            id=uuid.uuid4(),
            email=f"{uuid.uuid4()}@example.com",
            display_name="Other",
            password_hash="x",
        )
        session.add(other)
        await session.flush()
        other_id = other.id

    # The other user has their own (empty) preferences and cannot see the caller's default policy.
    assert (await client.get("/api/notifications/reminders")).json() == {
        "default": {"days_before": 1, "at_time": "09:00"}
    }
    async with session_scope() as session:
        other_defaults = await session.scalars(
            select(ReminderPolicy).where(
                ReminderPolicy.user_id == other_id, ReminderPolicy.is_default.is_(True)
            )
        )
        assert list(other_defaults) == []
    # A task the caller does not own is invisible (a 404, never another user's task).
    other_task = await _seed_task(other_id)
    assert (await client.get(f"/api/tasks/{other_task}/reminder")).status_code == 404


# --- per-entity override ------------------------------------------------------


async def test_a_per_entity_override_beats_the_default_and_reschedules(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    owner = await _owner_id()
    task_id = await _seed_task(owner)
    await _set_default(client, headers, days_before=0, at_time="09:00")

    response = await client.put(
        f"/api/tasks/{task_id}/reminder",
        json={"timing": {"days_before": 1, "at_time": "09:00"}},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["override"] == {"days_before": 1, "at_time": "09:00"}
    assert body["effective"] == {"days_before": 1, "at_time": "09:00"}
    assert datetime.fromisoformat(body["remind_at"].replace("Z", "+00:00")) == _DAY_BEFORE_9AM

    reminder = await _reminder(task_id)
    assert reminder is not None and reminder.remind_at == _DAY_BEFORE_9AM

    # Reading the task's reminder returns the same override + effective values.
    read_back = await client.get(f"/api/tasks/{task_id}/reminder")
    assert read_back.json()["override"] == {"days_before": 1, "at_time": "09:00"}

    # Clearing the override falls back to the default (and reschedules back).
    cleared = await client.put(
        f"/api/tasks/{task_id}/reminder", json={"timing": None}, headers=headers
    )
    assert cleared.status_code == 200
    assert cleared.json()["override"] is None
    assert cleared.json()["effective"] == {"days_before": 0, "at_time": "09:00"}
    back = await _reminder(task_id)
    assert back is not None and back.remind_at == _DUE_9AM


async def test_repeated_overrides_reuse_one_policy_row(client: AsyncClient) -> None:
    headers = await _auth(client)
    owner = await _owner_id()
    first = await _seed_task(owner)
    second = await _seed_task(owner)
    timing = {"days_before": 2, "at_time": "18:15"}

    await client.put(f"/api/tasks/{first}/reminder", json={"timing": timing}, headers=headers)
    await client.put(f"/api/tasks/{second}/reminder", json={"timing": timing}, headers=headers)
    await client.put(f"/api/tasks/{first}/reminder", json={"timing": timing}, headers=headers)

    # Equal overrides share one policy row rather than piling up duplicates.
    assert await _policy_count(owner) == 1


async def test_the_override_endpoint_rejects_an_unknown_task(client: AsyncClient) -> None:
    headers = await _auth(client)
    missing = uuid.uuid4()
    assert (await client.get(f"/api/tasks/{missing}/reminder")).status_code == 404
    response = await client.put(
        f"/api/tasks/{missing}/reminder",
        json={"timing": {"days_before": 1, "at_time": "09:00"}},
        headers=headers,
    )
    assert response.status_code == 404


async def test_an_invalid_override_is_rejected_with_no_side_effects(client: AsyncClient) -> None:
    headers = await _auth(client)
    owner = await _owner_id()
    task_id = await _seed_task(owner)
    response = await client.put(
        f"/api/tasks/{task_id}/reminder",
        json={"timing": {"days_before": 0, "at_time": "25:00"}},
        headers=headers,
    )
    assert response.status_code == 422
    assert await _reminder(task_id) is None
    assert await _policy_count(owner) == 0


# --- the scan picks up default-only tasks ------------------------------------


async def test_the_scan_materialises_reminders_for_default_only_tasks() -> None:
    """The M8-01 ``scan_reminders`` filter must include tasks that only inherit a default."""
    from atlas.reminders import scan_reminders

    user_id = await _seed_task_owner()
    async with session_scope() as session:
        session.add(
            ReminderPolicy(
                user_id=user_id,
                name="Default",
                days_before=0,
                at_time=time(9, 0),
                is_default=True,
            )
        )
    await _seed_task(user_id)

    async with session_scope() as session:
        summary = await scan_reminders(session)
    assert summary.considered == 1
    assert summary.scheduled == 1


async def _seed_task_owner() -> uuid.UUID:
    async with session_scope() as session:
        user = User(email=f"{uuid.uuid4()}@example.com", display_name="Owner", password_hash="x")
        session.add(user)
        await session.flush()
        return user.id
