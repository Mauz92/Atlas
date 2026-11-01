"""Task search and filters (M3-08) against a real PostgreSQL over HTTP.

Covers the M3-08 acceptance criteria: each filter individually (status, priority, a date range on
``start_at``/``due_at``, project), the text search over title/description (match, no match,
``LIKE`` metacharacters, an injection-shaped payload), filter combinations, the deterministic
ordering, the bounded result size, and the validation errors (``422``/``400``) that leave the data
untouched. Requires a database (``client`` pulls in ``_db``).
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from tests.conftest import create_user_via_setup, csrf_headers

if TYPE_CHECKING:
    from httpx import AsyncClient

#: Distinct, fixed due instants so the range cases are unambiguous and independent of "now".
DUE_1 = "2026-11-01T09:00:00Z"
DUE_2 = "2026-11-02T09:00:00Z"
DUE_3 = "2026-11-03T09:00:00Z"
DUE_4 = "2026-11-04T09:00:00Z"


async def _auth(client: AsyncClient) -> dict[str, str]:
    await create_user_via_setup(client)
    return csrf_headers(client)


async def _create(client: AsyncClient, headers: dict[str, str], **payload: object) -> dict:
    response = await client.post("/api/tasks", json={"title": "T", **payload}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


async def _titles(client: AsyncClient, **params: object) -> list[str]:
    response = await client.get("/api/tasks", params=params)
    assert response.status_code == 200, response.text
    return [task["title"] for task in response.json()["tasks"]]


async def _project(client: AsyncClient, headers: dict[str, str], name: str) -> str:
    """Create a real project (the FK requires one) and return its id."""
    response = await client.post("/api/projects", json={"name": name}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()["id"]


# --- individual filters -------------------------------------------------------


async def test_status_filter_accepts_repeated_and_comma_separated_values(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    await _create(client, headers, title="Inbox one")
    await _create(client, headers, title="Next one", status="next")
    await _create(client, headers, title="Working", status="in_progress")

    assert await _titles(client, status="next") == ["Next one"]
    assert await _titles(client, status=["inbox", "next"]) == ["Inbox one", "Next one"]
    assert await _titles(client, status="inbox,next") == ["Inbox one", "Next one"]


async def test_priority_filter_matches_one_priority(client: AsyncClient) -> None:
    headers = await _auth(client)
    await _create(client, headers, title="Urgent thing", priority="urgent")
    await _create(client, headers, title="Later thing", priority="low")

    assert await _titles(client, priority="urgent") == ["Urgent thing"]
    assert await _titles(client, priority="none") == []


async def test_due_range_filter_is_inclusive_and_excludes_undated_tasks(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    await _create(client, headers, title="First", due_at=DUE_1)
    await _create(client, headers, title="Second", due_at=DUE_2)
    await _create(client, headers, title="Third", due_at=DUE_3)
    await _create(client, headers, title="Someday")

    assert await _titles(client, due_from="2026-11-02", due_to="2026-11-03") == [
        "Second",
        "Third",
    ]
    assert await _titles(client, due_from="2026-11-03T09:00:00Z") == ["Third"]
    assert await _titles(client, due_to="2026-11-01T09:00:00Z") == ["First"]


async def test_start_range_filter_selects_scheduled_work(client: AsyncClient) -> None:
    headers = await _auth(client)
    await _create(client, headers, title="Morning block", start_at="2026-11-02T08:00:00Z")
    await _create(client, headers, title="Evening block", start_at="2026-11-02T18:00:00Z")

    assert await _titles(client, start_from="2026-11-02", start_to="2026-11-02T12:00:00Z") == [
        "Morning block"
    ]


async def test_project_filter_selects_one_project(client: AsyncClient) -> None:
    headers = await _auth(client)
    project = await _project(client, headers, "Alpha")
    other = await _project(client, headers, "Beta")
    await _create(client, headers, title="In project", project_id=project)
    await _create(client, headers, title="Elsewhere", project_id=other)
    await _create(client, headers, title="Unfiled")

    assert await _titles(client, project_id=project) == ["In project"]
    # An unknown (but well-formed) project id simply matches nothing.
    assert await _titles(client, project_id=str(uuid.uuid4())) == []


async def test_search_matches_title_and_description_case_insensitively(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    await _create(client, headers, title="Plan the week")
    await _create(client, headers, title="Groceries", description="Buy MILK and bread")
    await _create(client, headers, title="Unrelated")

    assert await _titles(client, q="plan") == ["Plan the week"]
    assert await _titles(client, q="milk") == ["Groceries"]
    assert await _titles(client, q="the") == ["Plan the week"]
    assert await _titles(client, q="nothing here") == []


async def test_search_terms_are_trimmed(client: AsyncClient) -> None:
    headers = await _auth(client)
    await _create(client, headers, title="Plan the week")

    assert await _titles(client, q="  plan  ") == ["Plan the week"]


async def test_search_escapes_like_metacharacters(client: AsyncClient) -> None:
    headers = await _auth(client)
    await _create(client, headers, title="100% done")
    await _create(client, headers, title="100 done")
    await _create(client, headers, title="a_b")
    await _create(client, headers, title="axb")

    # `%` and `_` match literally, they are not wildcards: only the titles that actually contain
    # the character match, so a lone wildcard cannot select everything.
    assert await _titles(client, q="100%") == ["100% done"]
    assert await _titles(client, q="a_b") == ["a_b"]
    assert await _titles(client, q="%") == ["100% done"]
    assert await _titles(client, q="_") == ["a_b"]


async def test_search_handles_quotes_and_non_ascii_text(client: AsyncClient) -> None:
    headers = await _auth(client)
    await _create(client, headers, title="Café ☕ planning")
    await _create(client, headers, title="It's a plan")

    assert await _titles(client, q="café") == ["Café ☕ planning"]
    assert await _titles(client, q="it's") == ["It's a plan"]


async def test_search_is_parameterised_and_cannot_alter_the_statement(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    payload = "Robert'); DROP TABLE tasks;--"
    await _create(client, headers, title=payload)
    await _create(client, headers, title="Survivor")

    matched = await _titles(client, q=payload)

    assert matched == [payload]
    # The statement was not injected into: the table and its other rows are intact.
    assert sorted(await _titles(client)) == sorted([payload, "Survivor"])


async def test_a_filtered_listing_excludes_soft_deleted_tasks(client: AsyncClient) -> None:
    headers = await _auth(client)
    kept = await _create(client, headers, title="Kept", due_at=DUE_2)
    doomed = await _create(client, headers, title="Doomed", due_at=DUE_2)

    assert (await client.delete(f"/api/tasks/{doomed['id']}", headers=headers)).status_code == 204

    assert await _titles(client, due_from="2026-11-02", due_to="2026-11-02") == [kept["title"]]


# --- combinations -------------------------------------------------------------


async def test_status_priority_date_and_project_filters_compose(client: AsyncClient) -> None:
    headers = await _auth(client)
    project = await _project(client, headers, "Alpha")
    other_project = await _project(client, headers, "Beta")
    await _create(
        client,
        headers,
        title="Match",
        status="next",
        priority="high",
        due_at=DUE_2,
        project_id=project,
    )
    await _create(
        client,
        headers,
        title="Wrong status",
        status="inbox",
        priority="high",
        due_at=DUE_2,
        project_id=project,
    )
    await _create(
        client,
        headers,
        title="Wrong priority",
        status="next",
        priority="low",
        due_at=DUE_2,
        project_id=project,
    )
    await _create(
        client,
        headers,
        title="Outside the range",
        status="next",
        priority="high",
        due_at=DUE_4,
        project_id=project,
    )
    await _create(
        client,
        headers,
        title="Other project",
        status="next",
        priority="high",
        due_at=DUE_2,
        project_id=other_project,
    )

    assert await _titles(
        client,
        status="next",
        priority="high",
        due_from="2026-11-02",
        due_to="2026-11-02",
        project_id=project,
    ) == ["Match"]


async def test_filters_compose_with_a_view(client: AsyncClient) -> None:
    headers = await _auth(client)
    await _create(client, headers, title="Inbox plan")
    await _create(client, headers, title="Next plan", status="next")
    await _create(client, headers, title="Inbox chore")

    assert await _titles(client, view="inbox", q="plan") == ["Inbox plan"]
    assert await _titles(client, view="inbox", status="next") == []
    assert await _titles(client, view="inbox", status="inbox") == ["Inbox plan", "Inbox chore"]


async def test_filters_compose_with_parent_task_id(client: AsyncClient) -> None:
    headers = await _auth(client)
    parent = await _create(client, headers, title="Parent")
    await _create(
        client, headers, title="Child match", parent_task_id=parent["id"], priority="high"
    )
    await _create(client, headers, title="Child miss", parent_task_id=parent["id"])

    assert await _titles(client, parent_task_id=parent["id"], priority="high") == ["Child match"]
    assert await _titles(client, parent_task_id=parent["id"], q="match") == ["Child match"]


# --- ordering and bounds ------------------------------------------------------


async def test_a_filtered_listing_is_ordered_by_priority_then_due_date(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    await _create(client, headers, title="Low early", priority="low", due_at=DUE_1)
    await _create(client, headers, title="Urgent late", priority="urgent", due_at=DUE_3)
    await _create(client, headers, title="Urgent early", priority="urgent", due_at=DUE_2)
    await _create(client, headers, title="No priority, no date", priority="none")

    assert await _titles(client, status="inbox") == [
        "Urgent early",
        "Urgent late",
        "Low early",
        "No priority, no date",
    ]


async def test_the_default_listing_and_order_are_unchanged(client: AsyncClient) -> None:
    headers = await _auth(client)
    first = await _create(client, headers, title="First", priority="none")
    second = await _create(client, headers, title="Second", priority="urgent", due_at=DUE_2)
    third = await _create(client, headers, title="Third")

    listing = await client.get("/api/tasks")

    assert listing.status_code == 200
    # Capture order, not priority order: no filter means the original listing is preserved.
    assert [task["id"] for task in listing.json()["tasks"]] == [
        first["id"],
        second["id"],
        third["id"],
    ]


async def test_limit_bounds_the_result_size(client: AsyncClient) -> None:
    headers = await _auth(client)
    for priority in ("none", "low", "medium", "high"):
        await _create(client, headers, title=f"{priority} task", priority=priority)

    limited = await client.get("/api/tasks", params={"limit": 2, "status": "inbox"})

    assert limited.status_code == 200
    assert [task["title"] for task in limited.json()["tasks"]] == ["high task", "medium task"]
    assert len((await client.get("/api/tasks", params={"status": "inbox"})).json()["tasks"]) == 4


# --- validation ---------------------------------------------------------------


async def _assert_rejected(
    client: AsyncClient, params: dict[str, object], expected: int = 422
) -> None:
    """A rejected request returns ``expected`` and leaves the listing byte-for-byte identical."""
    before = (await client.get("/api/tasks")).json()

    response = await client.get("/api/tasks", params=params)

    assert response.status_code == expected, (params, response.text)
    assert (await client.get("/api/tasks")).json() == before


async def test_an_unknown_status_is_rejected(client: AsyncClient) -> None:
    await _auth(client)
    await _assert_rejected(client, {"status": "someday"})
    await _assert_rejected(client, {"status": "inbox,someday"})


async def test_an_unknown_priority_is_rejected(client: AsyncClient) -> None:
    await _auth(client)
    await _assert_rejected(client, {"priority": "someday"})


async def test_a_malformed_date_bound_is_rejected(client: AsyncClient) -> None:
    await _auth(client)
    await _assert_rejected(client, {"due_from": "yesterday"})
    await _assert_rejected(client, {"due_to": "2026-13-01"})
    await _assert_rejected(client, {"start_from": "not-a-date"})


async def test_an_inverted_range_is_rejected(client: AsyncClient) -> None:
    await _auth(client)
    await _assert_rejected(client, {"due_from": "2026-11-03", "due_to": "2026-11-01"})
    await _assert_rejected(client, {"start_from": "2026-11-03", "start_to": "2026-11-01"})


async def test_an_over_long_search_term_is_rejected(client: AsyncClient) -> None:
    await _auth(client)
    await _assert_rejected(client, {"q": "x" * 201})


async def test_an_empty_search_term_is_rejected(client: AsyncClient) -> None:
    await _auth(client)
    await _assert_rejected(client, {"q": ""})


async def test_an_out_of_range_limit_is_rejected(client: AsyncClient) -> None:
    await _auth(client)
    await _assert_rejected(client, {"limit": 0})
    await _assert_rejected(client, {"limit": 501})


async def test_a_malformed_project_id_is_rejected(client: AsyncClient) -> None:
    await _auth(client)
    await _assert_rejected(client, {"project_id": "not-a-uuid"})


async def test_a_rejected_filter_creates_and_changes_nothing(client: AsyncClient) -> None:
    headers = await _auth(client)
    existing = await _create(client, headers, title="Existing", due_at=DUE_2)

    before = (await client.get("/api/tasks")).json()

    for params in (
        {"status": "someday"},
        {"priority": "someday"},
        {"due_from": "yesterday"},
        {"due_from": "2026-11-03", "due_to": "2026-11-01"},
        {"project_id": "not-a-uuid"},
        {"q": "x" * 201},
        {"limit": 0},
    ):
        response = await client.get("/api/tasks", params=params)
        assert response.status_code in {400, 422}, (params, response.text)

    after = (await client.get("/api/tasks")).json()
    assert after == before
    assert [task["id"] for task in after["tasks"]] == [existing["id"]]
    assert after["tasks"][0]["revision"] == 1


async def test_view_and_parent_task_id_are_still_incompatible(client: AsyncClient) -> None:
    headers = await _auth(client)
    parent = await _create(client, headers, title="Parent")

    response = await client.get(
        "/api/tasks",
        params={"view": "today", "parent_task_id": parent["id"], "status": "inbox"},
    )
    assert response.status_code == 400


async def test_an_unknown_view_is_still_rejected_with_filters(client: AsyncClient) -> None:
    await _auth(client)
    response = await client.get("/api/tasks", params={"view": "someday", "status": "inbox"})
    assert response.status_code == 422
