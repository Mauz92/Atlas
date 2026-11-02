"""Unified search (MU-05) against a real PostgreSQL: scoping, bounds, matching and the indexes."""

from __future__ import annotations

import os
import uuid
from typing import TYPE_CHECKING

import pytest
from sqlalchemy import create_engine, event, text

from atlas.db import get_engine, session_scope
from atlas.models import NoteIndex, Project, Task, User
from atlas.search import SearchService, prefix_tsquery
from tests.conftest import create_user_via_setup, csrf_headers

if TYPE_CHECKING:
    from httpx import AsyncClient


async def _auth(client: AsyncClient) -> dict[str, str]:
    await create_user_via_setup(client)
    return csrf_headers(client)


async def _post(client: AsyncClient, headers: dict[str, str], url: str, **body: object) -> dict:
    response = await client.post(url, json=body, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


async def _search(client: AsyncClient, q: str, **params: object) -> dict:
    response = await client.get("/api/search", params={"q": q, **params})
    assert response.status_code == 200, response.text
    return response.json()


async def test_search_requires_authentication(client: AsyncClient) -> None:
    assert (await client.get("/api/search", params={"q": "x"})).status_code == 401


@pytest.mark.parametrize(
    "params",
    [{}, {"q": ""}, {"q": "x" * 201}, {"q": "x", "limit": 0}, {"q": "x", "limit": 51}],
)
async def test_invalid_parameters_are_rejected(client: AsyncClient, params: dict) -> None:
    await _auth(client)
    assert (await client.get("/api/search", params=params)).status_code == 422


@pytest.mark.parametrize(
    "q",
    ["   ", "%%%", "& | ! ( ) :* <-> ' \\", "a & | b ((", "'; DROP TABLE tasks; --", "the"],
)
async def test_text_without_usable_words_or_with_tsquery_syntax_is_harmless(
    client: AsyncClient, q: str
) -> None:
    headers = await _auth(client)
    await _post(client, headers, "/api/tasks", title="Anything")
    body = await _search(client, q)
    assert body["query"] == q
    assert body["notes"] == body["projects"] == []
    assert body["tasks"] == []


def test_prefix_tsquery_keeps_only_word_characters() -> None:
    assert prefix_tsquery("Buy  mi") == "Buy:* & mi:*"
    assert prefix_tsquery("a&b|c!(d)") == "a:* & b:* & c:* & d:*"
    assert prefix_tsquery("%%% ::") is None
    assert prefix_tsquery(" ".join(f"w{i}" for i in range(20))).count("&") == 7


async def test_finds_notes_tasks_and_projects_by_word_prefix(notes_client: AsyncClient) -> None:
    client = notes_client
    headers = await _auth(client)
    note = await _post(client, headers, "/api/notes", path="Zebra plan.md", content="# Zebra\n")
    # A word that appears only in the *content* of a note is found, but the content is not returned.
    await _post(client, headers, "/api/notes", path="Other.md", content="# Other\nquokka habitat\n")
    task = await _post(client, headers, "/api/tasks", title="Feed the zebra", priority="high")
    project = await _post(client, headers, "/api/projects", name="Zebra crossing")
    await _post(client, headers, "/api/tasks", title="Unrelated")

    body = await _search(client, "zeb")
    assert [n["id"] for n in body["notes"]] == [note["id"]]
    assert [t["id"] for t in body["tasks"]] == [task["id"]]
    assert body["tasks"][0]["priority"] == "high"
    assert [p["id"] for p in body["projects"]] == [project["id"]]

    content_hit = await _search(client, "quok")
    assert [n["path"] for n in content_hit["notes"]] == ["Other.md"]
    assert "content" not in content_hit["notes"][0]

    assert (await _search(client, "feed zeb"))["tasks"][0]["id"] == task["id"]
    assert (await _search(client, "feed giraffe"))["tasks"] == []


async def test_open_work_ranks_before_closed_and_deleted_items_are_hidden(
    client: AsyncClient,
) -> None:
    headers = await _auth(client)
    done = await _post(client, headers, "/api/tasks", title="Report old")
    await client.patch(
        f"/api/tasks/{done['id']}",
        json={"status": "completed", "base_revision": done["revision"]},
        headers=headers,
    )
    open_task = await _post(client, headers, "/api/tasks", title="Report new")
    gone = await _post(client, headers, "/api/tasks", title="Report deleted")
    await client.delete(f"/api/tasks/{gone['id']}", headers=headers)
    live = await _post(client, headers, "/api/projects", name="Report live")
    dead = await _post(client, headers, "/api/projects", name="Report dead")
    await client.delete(f"/api/projects/{dead['id']}", headers=headers)

    body = await _search(client, "report")
    assert [t["id"] for t in body["tasks"]] == [open_task["id"], done["id"]]
    assert [p["id"] for p in body["projects"]] == [live["id"]]


async def test_limit_bounds_each_group(client: AsyncClient) -> None:
    headers = await _auth(client)
    for i in range(4):
        await _post(client, headers, "/api/tasks", title=f"Chore {i}")
        await _post(client, headers, "/api/projects", name=f"Chore project {i}")
    body = await _search(client, "chore", limit=3)
    assert len(body["tasks"]) == len(body["projects"]) == 3
    assert len((await _search(client, "chore"))["tasks"]) == 4


async def test_results_never_cross_users(client: AsyncClient) -> None:
    headers = await _auth(client)
    mine = await _post(client, headers, "/api/tasks", title="Secret mine")
    async with session_scope() as session:
        other = User(
            id=uuid.uuid4(),
            email=f"{uuid.uuid4()}@example.com",
            display_name="Other",
            password_hash="not-used",
        )
        session.add(other)
        await session.flush()
        session.add_all(
            [
                Task(user_id=other.id, title="Secret theirs"),
                Project(user_id=other.id, name="Secret project theirs"),
                NoteIndex(
                    user_id=other.id,
                    path="Secret.md",
                    title="Secret",
                    content_hash="0" * 64,
                ),
            ]
        )
        await session.flush()
        await session.execute(
            text("UPDATE notes SET search_vector = to_tsvector('english', 'secret note')")
        )

    body = await _search(client, "secret")
    assert [t["id"] for t in body["tasks"]] == [mine["id"]]
    assert body["projects"] == body["notes"] == []


async def test_task_and_project_queries_use_their_indexes(client: AsyncClient) -> None:
    """The statements are the ones the endpoint runs; with sequential scans disabled the planner
    must be able to answer them from the GIN expression indexes (R-20)."""
    await _auth(client)
    user_id = uuid.uuid4()
    async with session_scope() as session:
        await session.execute(
            text(
                "INSERT INTO users (id, email, display_name, password_hash) "
                "VALUES (:id, 'bulk@example.com', 'Bulk', 'x')"
            ),
            {"id": user_id},
        )
        # Enough rows that a word match is far more selective than the user filter.
        await session.execute(
            text(
                "INSERT INTO tasks (id, user_id, title) "
                "SELECT gen_random_uuid(), :id, 'task ' || n FROM generate_series(1, 3000) n"
            ),
            {"id": user_id},
        )
        await session.execute(
            text(
                "INSERT INTO projects (id, user_id, name) "
                "SELECT gen_random_uuid(), :id, 'project ' || n FROM generate_series(1, 3000) n"
            ),
            {"id": user_id},
        )
    async with get_engine().connect() as connection:
        await connection.execution_options(isolation_level="AUTOCOMMIT")
        await connection.exec_driver_sql("ANALYZE tasks")
        await connection.exec_driver_sql("ANALYZE projects")
    seen: list[tuple[str, object]] = []

    def grab(conn, cursor, statement, parameters, context, executemany) -> None:
        seen.append((statement, parameters))

    engine = get_engine().sync_engine
    async with session_scope() as session:
        service = SearchService(session, user_id)
        connection = await session.connection()
        await connection.exec_driver_sql("SET LOCAL enable_seqscan = off")
        event.listen(engine, "before_cursor_execute", grab)
        try:
            for statement, index in (
                (service.task_statement("zeb:*", 5), "ix_tasks_search_fts"),
                (service.project_statement("zeb:*", 5), "ix_projects_search_fts"),
            ):
                seen.clear()
                await session.execute(statement)
                sql, parameters = seen[-1]
                plan = (await connection.exec_driver_sql("EXPLAIN " + sql, parameters)).scalars()
                plan_text = "\n".join(plan)
                assert index in plan_text, plan_text
        finally:
            event.remove(engine, "before_cursor_execute", grab)


@pytest.mark.usefixtures("_schema")
def test_migration_adds_and_removes_the_search_indexes() -> None:
    """Downgrade one step from head and upgrade again: only the two indexes come and go."""
    from atlas.migrations import downgrade, upgrade

    engine = create_engine(os.environ["DATABASE_URL"])
    query = text("SELECT indexname FROM pg_indexes WHERE indexname LIKE 'ix\\_%\\_search\\_fts'")

    def names() -> set[str]:
        with engine.connect() as connection:
            return set(connection.execute(query).scalars())

    try:
        assert names() == {"ix_tasks_search_fts", "ix_projects_search_fts"}
        downgrade("f1b2c3d4e5a6")
        assert names() == set()
        upgrade("head")
        assert names() == {"ix_tasks_search_fts", "ix_projects_search_fts"}
    finally:
        engine.dispose()
