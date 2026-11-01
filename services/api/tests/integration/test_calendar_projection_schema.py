"""Projection/cursor schema against a real PostgreSQL (M5-06).

Covers the migration/model agreement and the integrity rules the tables must enforce: the
one-per-key unique constraints, the tombstone column and the account-deletion cascade.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError

from atlas.db import Base, get_engine, session_scope
from atlas.models import ExternalEvent, SyncCursor, User

pytestmark = pytest.mark.usefixtures("_db")

NOW = datetime(2026, 10, 27, 9, 0, tzinfo=UTC)


async def _create_user(session) -> User:
    user = User(
        email=f"{uuid.uuid4()}@example.com",
        display_name="Owner",
        password_hash="not-used-by-schema-tests",
    )
    session.add(user)
    await session.flush()
    return user


def _event_row(user_id: uuid.UUID, external_event_id: str = "e1") -> ExternalEvent:
    return ExternalEvent(
        user_id=user_id,
        provider="google",
        external_event_id=external_event_id,
        calendar_id="cal-primary",
        summary="Standup",
        start_at=NOW,
        end_at=NOW,
        time_zone="Europe/Berlin",
        status="confirmed",
        source_updated_at=NOW,
        last_synced_at=NOW,
    )


def _cursor_row(user_id: uuid.UUID) -> SyncCursor:
    return SyncCursor(
        user_id=user_id,
        provider="google",
        calendar_id="cal-primary",
        cursor_type="sync_token",
        cursor_value="rev:1",
    )


async def test_migrations_match_models() -> None:
    engine = get_engine()

    def _diff(sync_connection):
        context = MigrationContext.configure(sync_connection, opts={"compare_type": True})
        return compare_metadata(context, Base.metadata)

    async with engine.connect() as connection:
        diffs = await connection.run_sync(_diff)

    assert diffs == []


async def test_is_all_day_defaults_to_false_and_timestamps_are_set() -> None:
    async with session_scope() as session:
        user = await _create_user(session)
        user_id = user.id
        session.add(_event_row(user_id))
        await session.flush()

    async with session_scope() as session:
        row = (
            await session.execute(select(ExternalEvent).where(ExternalEvent.user_id == user_id))
        ).scalar_one()
        assert row.is_all_day is False
        assert row.deleted_at is None
        assert row.created_at is not None
        assert row.updated_at is not None


async def test_a_projection_is_unique_per_user_provider_and_event() -> None:
    async with session_scope() as session:
        user = await _create_user(session)
        user_id = user.id
        session.add(_event_row(user_id, "dupe"))
        await session.flush()

    with pytest.raises(IntegrityError):
        async with session_scope() as session:
            session.add(_event_row(user_id, "dupe"))
            await session.flush()


async def test_two_users_may_each_project_the_same_external_event() -> None:
    async with session_scope() as session:
        first = await _create_user(session)
        second = await _create_user(session)
        session.add_all([_event_row(first.id, "shared"), _event_row(second.id, "shared")])
        await session.flush()


async def test_a_cursor_is_unique_per_user_provider_and_calendar() -> None:
    async with session_scope() as session:
        user = await _create_user(session)
        user_id = user.id
        session.add(_cursor_row(user_id))
        await session.flush()

    with pytest.raises(IntegrityError):
        async with session_scope() as session:
            session.add(_cursor_row(user_id))
            await session.flush()


async def test_a_projection_requires_an_existing_user() -> None:
    with pytest.raises(IntegrityError):
        async with session_scope() as session:
            session.add(_event_row(uuid.uuid4()))
            await session.flush()


async def test_deleting_a_user_cascades_to_projections_and_cursors() -> None:
    async with session_scope() as session:
        user = await _create_user(session)
        user_id = user.id
        session.add(_event_row(user_id))
        session.add(_cursor_row(user_id))
        await session.flush()

    async with session_scope() as session:
        await session.execute(delete(User).where(User.id == user_id))

    async with session_scope() as session:
        events = (
            (await session.execute(select(ExternalEvent).where(ExternalEvent.user_id == user_id)))
            .scalars()
            .all()
        )
        cursors = (
            (await session.execute(select(SyncCursor).where(SyncCursor.user_id == user_id)))
            .scalars()
            .all()
        )
        assert events == []
        assert cursors == []
