"""Project schema against a real PostgreSQL (M4-01).

Covers the integrity rules the ``projects`` table and the ``tasks.project_id`` foreign key must
enforce: database defaults, the owner foreign key, and the documented ``ON DELETE SET NULL``
behaviour that keeps a task alive when its project is removed (ADR-0020).
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import delete, select, text
from sqlalchemy.exc import IntegrityError

from atlas.db import session_scope
from atlas.models import Project, ProjectStatus, Task, User

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


async def test_database_applies_project_defaults() -> None:
    async with session_scope() as session:
        user = await _create_user(session)
        project_id = uuid.uuid4()
        await session.execute(
            text("INSERT INTO projects (id, user_id, name) VALUES (:id, :user_id, 'raw')"),
            {"id": project_id, "user_id": user.id},
        )

    async with session_scope() as session:
        project = (
            await session.execute(select(Project).where(Project.id == project_id))
        ).scalar_one()
        assert project.status == ProjectStatus.ACTIVE.value
        assert project.revision == 1
        assert project.created_at is not None
        assert project.deleted_at is None
        assert project.start_date is None and project.target_date is None


async def test_project_requires_an_existing_user() -> None:
    with pytest.raises(IntegrityError):
        async with session_scope() as session:
            session.add(Project(user_id=uuid.uuid4(), name="orphan"))
            await session.flush()


async def test_deleting_a_user_cascades_to_projects() -> None:
    async with session_scope() as session:
        user = await _create_user(session)
        user_id = user.id
        session.add(Project(user_id=user_id, name="doomed"))
        await session.flush()

    async with session_scope() as session:
        await session.execute(delete(User).where(User.id == user_id))

    async with session_scope() as session:
        remaining = (
            (await session.execute(select(Project).where(Project.user_id == user_id)))
            .scalars()
            .all()
        )
        assert remaining == []


async def test_a_task_can_reference_an_existing_project() -> None:
    async with session_scope() as session:
        user = await _create_user(session)
        project = Project(user_id=user.id, name="Launch")
        session.add(project)
        await session.flush()
        task = Task(user_id=user.id, title="Ship it", project_id=project.id)
        session.add(task)
        await session.flush()
        assert task.project_id == project.id


async def test_a_task_cannot_reference_an_unknown_project() -> None:
    with pytest.raises(IntegrityError):
        async with session_scope() as session:
            user = await _create_user(session)
            session.add(Task(user_id=user.id, title="unfiled", project_id=uuid.uuid4()))
            await session.flush()


async def test_deleting_a_project_sets_its_tasks_project_to_null() -> None:
    """A hard project delete must never delete the tasks: their project_id is cleared instead."""
    async with session_scope() as session:
        user = await _create_user(session)
        project = Project(user_id=user.id, name="Removed")
        session.add(project)
        await session.flush()
        task = Task(user_id=user.id, title="Survivor", project_id=project.id)
        session.add(task)
        await session.flush()
        project_id, task_id = project.id, task.id

    async with session_scope() as session:
        await session.execute(delete(Project).where(Project.id == project_id))

    async with session_scope() as session:
        survivor = (await session.execute(select(Task).where(Task.id == task_id))).scalar_one()
        assert survivor.project_id is None
        assert survivor.deleted_at is None
