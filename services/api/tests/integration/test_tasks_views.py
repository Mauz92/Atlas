"""Inbox / Today / Upcoming views (M3-07) against a real PostgreSQL over HTTP.

Covers the acceptance criteria for the primary task views: each view is served by
``GET /api/tasks`` from the database; Today is overdue-or-due-today and excludes later, completed
and undated work; Upcoming is a later calendar day; the caller's ``tz`` decides "today" for a task
with no zone of its own while a task's own zone wins; and the boundary parameters are validated.
Requires a database (``client`` pulls in ``_db``).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

from sqlalchemy import select

from atlas.db import session_scope
from atlas.models import User
from atlas.tasks import TasksService, TaskView
from tests.conftest import create_user_via_setup, csrf_headers

if TYPE_CHECKING:
    from httpx import AsyncClient
    from sqlalchemy.ext.asyncio import AsyncSession


async def _auth(client: AsyncClient) -> dict[str, str]:
    await create_user_via_setup(client)
    return csrf_headers(client)


async def _create(client: AsyncClient, headers: dict[str, str], **payload: object) -> dict:
    response = await client.post("/api/tasks", json={"title": "T", **payload}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


def _iso(delta_days: float) -> str:
    """An instant offset from the real "now", so overdue/upcoming cases stay unambiguous."""
    return (datetime.now(UTC) + timedelta(days=delta_days)).isoformat()


async def _user_id(session: AsyncSession, email: str = "owner@example.com") -> uuid.UUID:
    user_id = await session.scalar(select(User.id).where(User.email == email))
    assert user_id is not None
    return user_id


async def test_inbox_view_lists_only_inbox_tasks(client: AsyncClient) -> None:
    headers = await _auth(client)
    await _create(client, headers, title="Captured")
    await _create(client, headers, title="Triaged", status="next")

    listing = await client.get("/api/tasks", params={"view": "inbox"})

    assert listing.status_code == 200
    assert [task["title"] for task in listing.json()["tasks"]] == ["Captured"]


async def test_today_lists_overdue_work_and_upcoming_lists_later_days(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    overdue = await _create(client, headers, title="Late", due_at=_iso(-2))
    later = await _create(client, headers, title="Soon", due_at=_iso(2))
    await _create(client, headers, title="Someday")

    today = await client.get("/api/tasks", params={"view": "today"})
    assert [task["id"] for task in today.json()["tasks"]] == [overdue["id"]]
    assert today.json()["tasks"][0]["due_state"] == "overdue"

    upcoming = await client.get("/api/tasks", params={"view": "upcoming"})
    assert [task["id"] for task in upcoming.json()["tasks"]] == [later["id"]]
    assert upcoming.json()["tasks"][0]["due_state"] == "upcoming"


async def test_completed_and_archived_tasks_are_not_in_active_views(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    await _create(client, headers, title="Done", due_at=_iso(-1), status="completed")
    await _create(client, headers, title="Old", due_at=_iso(-1), status="archived")

    assert (await client.get("/api/tasks", params={"view": "today"})).json()["tasks"] == []


async def test_today_classification_uses_the_callers_zone(client: AsyncClient) -> None:
    headers = await _auth(client)
    # 23:30 UTC: the 26th in UTC, but already 00:30 on the 27th in Europe/Amsterdam (UTC+1).
    late = await _create(client, headers, title="Late evening", due_at="2026-10-26T23:30:00Z")
    reference = datetime(2026, 10, 26, 12, 0, tzinfo=UTC)

    async with session_scope() as session:
        service = TasksService(session, await _user_id(session))
        in_utc = await service.list_view(TaskView.TODAY, caller_tz="UTC", now=reference)
        in_amsterdam = await service.list_view(
            TaskView.TODAY, caller_tz="Europe/Amsterdam", now=reference
        )

    assert [task.id for task in in_utc] == [uuid.UUID(late["id"])]
    assert in_amsterdam == []


async def test_today_includes_a_task_due_later_the_same_day(client: AsyncClient) -> None:
    headers = await _auth(client)
    await _create(
        client,
        headers,
        title="This afternoon",
        due_at="2026-10-26T22:30:00Z",
        time_zone="Europe/Amsterdam",
    )
    reference = datetime(2026, 10, 26, 12, 0, tzinfo=UTC)

    async with session_scope() as session:
        service = TasksService(session, await _user_id(session))
        tasks = await service.list_view(TaskView.TODAY, caller_tz="Europe/Amsterdam", now=reference)

    assert [task.title for task in tasks] == ["This afternoon"]


async def test_a_tasks_own_zone_wins_over_the_callers_zone(client: AsyncClient) -> None:
    headers = await _auth(client)
    # 19:30 on the 26th in New York, so it is due "today" for that task even though an Amsterdam
    # caller is already on the 27th.
    await _create(
        client,
        headers,
        title="New York evening",
        due_at="2026-10-26T23:30:00Z",
        time_zone="America/New_York",
    )
    reference = datetime(2026, 10, 26, 12, 0, tzinfo=UTC)

    async with session_scope() as session:
        service = TasksService(session, await _user_id(session))
        tasks = await service.list_view(TaskView.TODAY, caller_tz="Europe/Amsterdam", now=reference)

    assert [task.title for task in tasks] == ["New York evening"]


async def test_a_task_reports_its_due_state_everywhere(client: AsyncClient) -> None:
    headers = await _auth(client)
    created = await _create(client, headers, title="Late", due_at=_iso(-1))
    assert created["due_state"] == "overdue"

    fetched = await client.get(f"/api/tasks/{created['id']}")
    assert fetched.json()["due_state"] == "overdue"


async def test_the_default_listing_and_order_are_unchanged(client: AsyncClient) -> None:
    headers = await _auth(client)
    first = await _create(client, headers, title="First")
    second = await _create(client, headers, title="Second", due_at=_iso(2))

    listing = await client.get("/api/tasks")

    assert [task["id"] for task in listing.json()["tasks"]] == [first["id"], second["id"]]
    assert all("due_state" in task for task in listing.json()["tasks"])


async def test_an_unknown_view_is_rejected(client: AsyncClient) -> None:
    await _auth(client)
    response = await client.get("/api/tasks", params={"view": "someday"})
    assert response.status_code == 422


async def test_an_unknown_time_zone_is_rejected(client: AsyncClient) -> None:
    await _auth(client)
    response = await client.get("/api/tasks", params={"view": "today", "tz": "Mars/Phobos"})
    assert response.status_code == 422


async def test_view_and_parent_task_id_cannot_be_combined(client: AsyncClient) -> None:
    headers = await _auth(client)
    parent = await _create(client, headers, title="Parent")
    response = await client.get(
        "/api/tasks", params={"view": "today", "parent_task_id": parent["id"]}
    )
    assert response.status_code == 400
