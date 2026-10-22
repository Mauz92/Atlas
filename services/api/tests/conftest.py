"""Shared test fixtures.

Environment is configured before Atlas is imported so that settings (and the cached
settings object) point at the test database. Integration tests require a real PostgreSQL;
set ``DATABASE_URL`` (or ``TEST_DATABASE_URL``) to point at it.
"""

from __future__ import annotations

import os

os.environ.setdefault("ATLAS_ENV", "test")
if "DATABASE_URL" not in os.environ:
    os.environ["DATABASE_URL"] = os.environ.get(
        "TEST_DATABASE_URL", "postgresql+psycopg://atlas@127.0.0.1:5433/atlas"
    )
os.environ.setdefault("SECRET_KEY", "test-secret-key")
os.environ.setdefault("SESSION_SECRET", "test-session-secret")
os.environ.setdefault("TOKEN_ENCRYPTION_KEY", "test-token-encryption-key")

from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import TYPE_CHECKING

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text

if TYPE_CHECKING:
    from atlas.notes import NotesStorage

_TRUNCATE = (
    "TRUNCATE TABLE jobs, sessions, users, notes, tags, note_links, note_tags, "
    "tasks, recurrence_series, task_tags, task_links CASCADE"
)


@pytest.fixture(scope="session", autouse=True)
def _schema() -> Iterator[None]:
    from atlas.migrations import downgrade, upgrade

    downgrade("base")
    upgrade("head")
    yield


@pytest.fixture
async def app() -> FastAPI:
    from atlas.main import create_app

    return create_app()


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[AsyncClient]:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as async_client:
        yield async_client


@pytest.fixture
def notes_storage(tmp_path: Path) -> NotesStorage:
    from atlas.notes import NotesStorage

    storage = NotesStorage(tmp_path / "notes")
    storage.ensure_root()
    return storage


@pytest.fixture
async def notes_client(app: FastAPI, notes_storage: NotesStorage) -> AsyncIterator[AsyncClient]:
    """A client whose notes endpoints operate on a per-test notes root."""
    from atlas.api.notes import get_storage

    app.dependency_overrides[get_storage] = lambda: notes_storage
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as async_client:
        yield async_client
    app.dependency_overrides.clear()


@pytest.fixture(autouse=True)
async def _reset_state() -> AsyncIterator[None]:
    from atlas.api.auth import _login_limiter
    from atlas.db import dispose_engine, session_scope

    _login_limiter.reset()
    yield
    async with session_scope() as session:
        await session.execute(text(_TRUNCATE))
    await dispose_engine()


def csrf_headers(client: AsyncClient) -> dict[str, str]:
    token = client.cookies.get("atlas_csrf")
    return {"X-CSRF-Token": token} if token else {}


async def create_user_via_setup(
    client: AsyncClient,
    *,
    email: str = "owner@example.com",
    password: str = "correct horse battery",
) -> None:
    response = await client.post(
        "/api/auth/setup",
        json={"email": email, "password": password, "display_name": "Owner"},
    )
    assert response.status_code == 201, response.text
