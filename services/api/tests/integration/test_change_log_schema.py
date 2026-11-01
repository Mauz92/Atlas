"""Change feed schema against a real PostgreSQL (M7-01).

Covers the migration/model agreement and the integrity rules the ``change_log`` store must enforce:
the cursor is unique per user, change rows require an existing user, account deletion cascades, the
per-user counter starts at zero, and the recorder advances it monotonically while keeping one row
per entity. Needs a database (``_db``).
"""

from __future__ import annotations

import uuid

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import delete, select, text
from sqlalchemy.exc import IntegrityError

from atlas.changes import ChangeEntityType, ChangeOperation, ChangeRecorder
from atlas.db import Base, get_engine, session_scope
from atlas.models import ChangeLog, User

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


async def test_the_counter_defaults_to_zero() -> None:
    user_id = uuid.uuid4()
    async with session_scope() as session:
        await session.execute(
            text(
                "INSERT INTO users (id, email, display_name, password_hash) "
                "VALUES (:id, :email, 'Raw', 'x')"
            ),
            {"id": user_id, "email": f"{uuid.uuid4()}@example.com"},
        )

    async with session_scope() as session:
        stored = await session.get(User, user_id)
        assert stored is not None
        assert stored.change_seq == 0


async def test_the_cursor_is_unique_per_user() -> None:
    async with session_scope() as session:
        user = await _create_user(session)
        session.add(
            ChangeLog(
                user_id=user.id,
                entity_type="task",
                entity_id="a",
                operation="upsert",
                seq=1,
            )
        )
        await session.flush()

    with pytest.raises(IntegrityError):
        async with session_scope() as session:
            session.add(
                ChangeLog(
                    user_id=user.id,
                    entity_type="task",
                    entity_id="b",
                    operation="upsert",
                    seq=1,
                )
            )
            await session.flush()


async def test_a_change_row_requires_an_existing_user() -> None:
    with pytest.raises(IntegrityError):
        async with session_scope() as session:
            session.add(
                ChangeLog(
                    user_id=uuid.uuid4(),
                    entity_type="task",
                    entity_id="a",
                    operation="upsert",
                    seq=1,
                )
            )
            await session.flush()


async def test_deleting_a_user_cascades_to_its_change_rows() -> None:
    async with session_scope() as session:
        user = await _create_user(session)
        record = ChangeLog(
            user_id=user.id, entity_type="task", entity_id="a", operation="upsert", seq=1
        )
        session.add(record)
        await session.flush()
        user_id = user.id

    async with session_scope() as session:
        await session.execute(delete(User).where(User.id == user_id))

    async with session_scope() as session:
        remaining = await session.scalar(
            select(text("count(*)")).select_from(ChangeLog).where(ChangeLog.user_id == user_id)
        )
        assert remaining == 0


async def test_the_recorder_is_monotonic_and_keeps_one_row_per_entity() -> None:
    async with session_scope() as session:
        user = await _create_user(session)
        recorder = ChangeRecorder(session, user.id)
        first = await recorder.record(ChangeEntityType.TASK, "first", ChangeOperation.UPSERT)
        second = await recorder.record(ChangeEntityType.PROJECT, "second", ChangeOperation.UPSERT)
        assert second > first
        # Re-recording the first entity advances its cursor and flips its operation, not its count.
        third = await recorder.record(ChangeEntityType.TASK, "first", ChangeOperation.DELETE)
        assert third > second
        user_id = user.id

    async with session_scope() as session:
        rows = (
            await session.scalars(
                select(ChangeLog).where(ChangeLog.user_id == user_id).order_by(ChangeLog.seq)
            )
        ).all()
        assert [(row.entity_type, row.entity_id, row.operation, row.seq) for row in rows] == [
            ("project", "second", "upsert", second),
            ("task", "first", "delete", third),
        ]
