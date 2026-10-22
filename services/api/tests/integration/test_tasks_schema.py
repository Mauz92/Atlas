"""Task schema against a real PostgreSQL (M3-01).

Covers the migration/model agreement and the integrity rules the schema must enforce:
database defaults, foreign keys (including the self-references) and cascade deletion.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import delete, select, text
from sqlalchemy.exc import IntegrityError

from atlas.db import Base, get_engine, session_scope
from atlas.models import Tag, Task, TaskPriority, TaskStatus, TaskTag, User

pytestmark = pytest.mark.usefixtures("_db")


async def _create_user(session) -> User:
    user = User(
        email=f"{uuid.uuid4()}@example.com",
        display_name="Owner",
        password_hash="not-used-by-schema-tests",
    )
    session.add(user)
    await session.flush()
    return user


async def test_migrations_match_models() -> None:
    engine = get_engine()

    def _diff(sync_connection):
        context = MigrationContext.configure(sync_connection, opts={"compare_type": True})
        return compare_metadata(context, Base.metadata)

    async with engine.connect() as connection:
        diffs = await connection.run_sync(_diff)

    assert diffs == []


async def test_database_applies_task_defaults() -> None:
    async with session_scope() as session:
        user = await _create_user(session)
        task_id = uuid.uuid4()
        await session.execute(
            text("INSERT INTO tasks (id, user_id, title) VALUES (:id, :user_id, 'raw')"),
            {"id": task_id, "user_id": user.id},
        )

    async with session_scope() as session:
        task = (await session.execute(select(Task).where(Task.id == task_id))).scalar_one()
        assert task.status == TaskStatus.INBOX.value
        assert task.priority == TaskPriority.NONE.value
        assert task.revision == 1
        assert task.created_at is not None
        assert task.deleted_at is None


async def test_optional_task_fields_round_trip() -> None:
    due = datetime(2026, 1, 2, 9, 30, tzinfo=UTC)
    async with session_scope() as session:
        user = await _create_user(session)
        task = Task(
            user_id=user.id,
            title="Plan the week",
            description="details",
            status=TaskStatus.NEXT.value,
            priority=TaskPriority.HIGH.value,
            due_at=due,
            time_zone="Europe/Amsterdam",
            duration_minutes=45,
            recurrence_rule="FREQ=WEEKLY;COUNT=3",
        )
        session.add(task)
        await session.flush()
        task_id = task.id

    async with session_scope() as session:
        stored = (await session.execute(select(Task).where(Task.id == task_id))).scalar_one()
        assert stored.due_at == due
        assert stored.time_zone == "Europe/Amsterdam"
        assert stored.duration_minutes == 45
        assert stored.recurrence_rule == "FREQ=WEEKLY;COUNT=3"
        assert stored.priority == TaskPriority.HIGH.value


async def test_task_requires_an_existing_user() -> None:
    with pytest.raises(IntegrityError):
        async with session_scope() as session:
            session.add(Task(user_id=uuid.uuid4(), title="orphan"))
            await session.flush()


async def test_subtask_requires_an_existing_parent() -> None:
    with pytest.raises(IntegrityError):
        async with session_scope() as session:
            user = await _create_user(session)
            session.add(Task(user_id=user.id, title="child", parent_task_id=uuid.uuid4()))
            await session.flush()


async def test_deleting_a_user_cascades_to_tasks() -> None:
    async with session_scope() as session:
        user = await _create_user(session)
        user_id = user.id
        session.add(Task(user_id=user_id, title="doomed"))
        await session.flush()

    async with session_scope() as session:
        await session.execute(delete(User).where(User.id == user_id))

    async with session_scope() as session:
        remaining = (
            (await session.execute(select(Task).where(Task.user_id == user_id))).scalars().all()
        )
        assert remaining == []


async def test_task_tag_requires_existing_task_and_tag() -> None:
    async with session_scope() as session:
        user = await _create_user(session)
        task = Task(user_id=user.id, title="tagged")
        tag = Tag(user_id=user.id, name="alpha")
        session.add_all([task, tag])
        await session.flush()
        session.add(TaskTag(task_id=task.id, tag_id=tag.id))
        await session.flush()

    with pytest.raises(IntegrityError):
        async with session_scope() as session:
            session.add(TaskTag(task_id=uuid.uuid4(), tag_id=uuid.uuid4()))
            await session.flush()
