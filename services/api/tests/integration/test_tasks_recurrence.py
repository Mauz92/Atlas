"""Recurring tasks (M3-05) against a real PostgreSQL.

Covers the core acceptance criterion over HTTP: completing one occurrence completes only that
occurrence and generates the next one; the series and its other occurrences are preserved; the
bounds (COUNT/UNTIL) terminate the series; and a retried completion with the same idempotency key
never duplicates an occurrence. Requires a database (``client`` pulls in ``_db``).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from httpx import AsyncClient
from sqlalchemy import select

from atlas.db import session_scope
from atlas.models import RecurrenceSeries
from tests.conftest import create_user_via_setup, csrf_headers


def _at(*parts: int) -> datetime:
    return datetime(*parts, tzinfo=UTC)


async def _auth(client: AsyncClient) -> dict[str, str]:
    await create_user_via_setup(client)
    return csrf_headers(client)


async def _create(client: AsyncClient, headers: dict[str, str], **payload: object) -> dict:
    response = await client.post(
        "/api/tasks", json={"title": "Stand-up", **payload}, headers=headers
    )
    assert response.status_code == 201, response.text
    return response.json()


async def _complete(
    client: AsyncClient, headers: dict[str, str], task_id: str, **extras: str
) -> dict:
    response = await client.patch(
        f"/api/tasks/{task_id}", json={"status": "completed"}, headers={**headers, **extras}
    )
    assert response.status_code == 200, response.text
    return response.json()


async def _tasks_by_due(client: AsyncClient) -> dict[datetime, dict]:
    listing = (await client.get("/api/tasks")).json()["tasks"]
    return {datetime.fromisoformat(task["due_at"]).astimezone(UTC): task for task in listing}


async def _series_for(head_id: str) -> list[RecurrenceSeries]:
    async with session_scope() as session:
        rows = await session.scalars(
            select(RecurrenceSeries).where(
                RecurrenceSeries.recurrence_parent_id == uuid.UUID(head_id)
            )
        )
        return list(rows)


async def test_creating_a_recurring_task_creates_the_series(client: AsyncClient) -> None:
    headers = await _auth(client)
    head = await _create(
        client, headers, due_at="2026-01-02T09:00:00Z", recurrence_rule="FREQ=DAILY;COUNT=3"
    )
    assert head["recurrence_rule"] == "FREQ=DAILY;COUNT=3"
    assert head["recurrence_parent_id"] is None

    series = await _series_for(head["id"])
    assert len(series) == 1
    assert series[0].rule == "FREQ=DAILY;COUNT=3"
    assert series[0].count == 3
    assert series[0].end_date is None


async def test_completing_an_occurrence_creates_the_next_and_keeps_the_series(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    head = await _create(
        client, headers, due_at="2026-01-02T09:00:00Z", recurrence_rule="FREQ=DAILY;COUNT=3"
    )

    completed = await _complete(client, headers, head["id"])
    assert completed["status"] == "completed"
    assert completed["completed_at"] is not None

    by_due = await _tasks_by_due(client)
    assert set(by_due) == {_at(2026, 1, 2, 9), _at(2026, 1, 3, 9)}
    assert by_due[_at(2026, 1, 2, 9)]["status"] == "completed"
    following = by_due[_at(2026, 1, 3, 9)]
    assert following["status"] == "inbox"
    assert following["recurrence_parent_id"] == head["id"]
    assert following["recurrence_rule"] == "FREQ=DAILY;COUNT=3"

    # The series row is preserved (the head still acts as the series head).
    assert len(await _series_for(head["id"])) == 1


async def test_completing_an_occurrence_leaves_earlier_occurrences_untouched(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    head = await _create(
        client, headers, due_at="2026-01-02T09:00:00Z", recurrence_rule="FREQ=DAILY;COUNT=4"
    )
    await _complete(client, headers, head["id"])

    second = (await _tasks_by_due(client))[_at(2026, 1, 3, 9)]
    await _complete(client, headers, second["id"])

    by_due = await _tasks_by_due(client)
    assert set(by_due) == {_at(2026, 1, 2, 9), _at(2026, 1, 3, 9), _at(2026, 1, 4, 9)}
    # The head is unchanged by completing the second occurrence.
    assert by_due[_at(2026, 1, 2, 9)]["id"] == head["id"]
    assert by_due[_at(2026, 1, 2, 9)]["status"] == "completed"
    assert by_due[_at(2026, 1, 3, 9)]["status"] == "completed"
    assert by_due[_at(2026, 1, 4, 9)]["status"] == "inbox"
    assert len(await _series_for(head["id"])) == 1


async def test_completing_the_final_occurrence_stops_the_series(client: AsyncClient) -> None:
    headers = await _auth(client)
    head = await _create(
        client, headers, due_at="2026-01-02T09:00:00Z", recurrence_rule="FREQ=DAILY;COUNT=2"
    )
    await _complete(client, headers, head["id"])

    second = (await _tasks_by_due(client))[_at(2026, 1, 3, 9)]
    await _complete(client, headers, second["id"])

    by_due = await _tasks_by_due(client)
    assert set(by_due) == {_at(2026, 1, 2, 9), _at(2026, 1, 3, 9)}
    assert by_due[_at(2026, 1, 3, 9)]["status"] == "completed"
    # The series still exists; there is simply no successor.
    assert len(await _series_for(head["id"])) == 1


async def test_until_bounds_terminate_the_series(client: AsyncClient) -> None:
    headers = await _auth(client)
    head = await _create(
        client,
        headers,
        due_at="2026-01-02T09:00:00Z",
        recurrence_rule="FREQ=DAILY;UNTIL=20260103T090000Z",
    )
    await _complete(client, headers, head["id"])
    # Only two occurrences before UNTIL; completing the second must not create a third.
    second = (await _tasks_by_due(client))[_at(2026, 1, 3, 9)]
    await _complete(client, headers, second["id"])
    assert set(await _tasks_by_due(client)) == {_at(2026, 1, 2, 9), _at(2026, 1, 3, 9)}


async def test_retrying_a_completion_with_the_same_key_does_not_duplicate(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    head = await _create(
        client, headers, due_at="2026-01-02T09:00:00Z", recurrence_rule="FREQ=DAILY;COUNT=5"
    )
    key = {"Idempotency-Key": "complete-1"}

    first = await _complete(client, headers, head["id"], **key)
    replay = await _complete(client, headers, head["id"], **key)
    assert replay == first

    assert set(await _tasks_by_due(client)) == {_at(2026, 1, 2, 9), _at(2026, 1, 3, 9)}


async def test_the_next_occurrence_is_timezone_and_dst_correct(client: AsyncClient) -> None:
    headers = await _auth(client)
    # Daily 09:00 in Amsterdam; the day before the spring-forward change it is 08:00Z, after 07:00Z.
    head = await _create(
        client,
        headers,
        due_at="2026-03-28T08:00:00Z",
        time_zone="Europe/Amsterdam",
        recurrence_rule="FREQ=DAILY;COUNT=3",
    )
    assert head["due_at"].startswith("2026-03-28T08:00:00")

    await _complete(client, headers, head["id"])

    follow = (await _tasks_by_due(client))[_at(2026, 3, 29, 7)]
    assert follow["time_zone"] == "Europe/Amsterdam"
    assert follow["recurrence_parent_id"] == head["id"]


async def test_reopening_an_occurrence_keeps_the_generated_next(client: AsyncClient) -> None:
    headers = await _auth(client)
    head = await _create(
        client, headers, due_at="2026-01-02T09:00:00Z", recurrence_rule="FREQ=DAILY;COUNT=3"
    )
    await _complete(client, headers, head["id"])

    reopened = await client.patch(
        f"/api/tasks/{head['id']}", json={"status": "in_progress"}, headers=headers
    )
    assert reopened.status_code == 200
    assert reopened.json()["completed_at"] is None
    # The next occurrence is untouched by the reopen.
    assert set(await _tasks_by_due(client)) == {_at(2026, 1, 2, 9), _at(2026, 1, 3, 9)}


async def test_an_invalid_recurrence_rule_is_rejected(client: AsyncClient) -> None:
    headers = await _auth(client)
    response = await client.post(
        "/api/tasks",
        json={"title": "x", "due_at": "2026-01-02T09:00:00Z", "recurrence_rule": "FREQ=NEVER"},
        headers=headers,
    )
    assert response.status_code == 422


async def test_a_recurring_task_requires_an_anchor(client: AsyncClient) -> None:
    headers = await _auth(client)
    response = await client.post(
        "/api/tasks", json={"title": "x", "recurrence_rule": "FREQ=DAILY"}, headers=headers
    )
    assert response.status_code == 400


async def test_a_recurrence_rule_can_be_added_on_update_and_then_advances(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    task = await _create(client, headers, due_at="2026-02-02T09:00:00Z")
    assert await _series_for(task["id"]) == []

    updated = await client.patch(
        f"/api/tasks/{task['id']}",
        json={"recurrence_rule": "FREQ=DAILY;COUNT=2"},
        headers=headers,
    )
    assert updated.status_code == 200
    assert len(await _series_for(task["id"])) == 1

    await _complete(client, headers, task["id"])
    assert set(await _tasks_by_due(client)) == {_at(2026, 2, 2, 9), _at(2026, 2, 3, 9)}


async def test_removing_the_rule_deletes_the_series(client: AsyncClient) -> None:
    headers = await _auth(client)
    head = await _create(
        client, headers, due_at="2026-01-02T09:00:00Z", recurrence_rule="FREQ=DAILY;COUNT=3"
    )
    response = await client.patch(
        f"/api/tasks/{head['id']}", json={"recurrence_rule": None}, headers=headers
    )
    assert response.status_code == 200
    assert response.json()["recurrence_rule"] is None
    assert await _series_for(head["id"]) == []
    assert len(await _tasks_by_due(client)) == 1


async def test_a_completed_occurrence_cannot_be_completed_again(client: AsyncClient) -> None:
    headers = await _auth(client)
    head = await _create(
        client, headers, due_at="2026-01-02T09:00:00Z", recurrence_rule="FREQ=DAILY;COUNT=3"
    )
    await _complete(client, headers, head["id"])
    again = await client.patch(
        f"/api/tasks/{head['id']}", json={"status": "completed"}, headers=headers
    )
    assert again.status_code == 409
    assert set(await _tasks_by_due(client)) == {_at(2026, 1, 2, 9), _at(2026, 1, 3, 9)}
