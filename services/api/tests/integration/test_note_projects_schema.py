"""Note↔project association schema against a real PostgreSQL (M4-05).

Covers the integrity rules the ``note_projects`` table must enforce: the composite key rejects a
duplicate link, both foreign keys require an existing row, and a *hard* delete of either side
cascades the link away (``ON DELETE CASCADE``, ADR-0024). The API's ordinary delete is a soft delete
and is covered over HTTP in ``test_note_projects.py``.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError

from atlas.db import session_scope
from atlas.models import NoteIndex, NoteProject, Project, User

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


async def _note(session, user: User, path: str = "Note.md") -> NoteIndex:
    note = NoteIndex(
        id=uuid.uuid4(),
        user_id=user.id,
        path=path,
        title="Note",
        content_hash="0" * 64,
        revision=1,
        size_bytes=0,
    )
    session.add(note)
    await session.flush()
    return note


async def test_the_composite_key_rejects_a_duplicate_link() -> None:
    async with session_scope() as session:
        user = await _create_user(session)
        project = Project(user_id=user.id, name="Launch")
        note = await _note(session, user)
        session.add(project)
        await session.flush()
        session.add(NoteProject(note_id=note.id, project_id=project.id))
        await session.flush()

    with pytest.raises(IntegrityError):
        async with session_scope() as session:
            session.add(NoteProject(note_id=note.id, project_id=project.id))
            await session.flush()


async def test_a_link_requires_an_existing_note_and_project() -> None:
    with pytest.raises(IntegrityError):
        async with session_scope() as session:
            session.add(NoteProject(note_id=uuid.uuid4(), project_id=uuid.uuid4()))
            await session.flush()


async def test_a_link_survives_the_note_id_with_a_rename_path_change() -> None:
    """The link is keyed on the note id, so changing ``notes.path`` leaves the row untouched."""
    async with session_scope() as session:
        user = await _create_user(session)
        project = Project(user_id=user.id, name="Launch")
        note = await _note(session, user, path="Old.md")
        session.add(project)
        await session.flush()
        session.add(NoteProject(note_id=note.id, project_id=project.id))
        await session.flush()
        note_id, project_id = note.id, project.id

    async with session_scope() as session:
        stored = await session.get(NoteIndex, note_id)
        assert stored is not None
        stored.path = "New/Name.md"

    async with session_scope() as session:
        rows = (
            (await session.execute(select(NoteProject).where(NoteProject.note_id == note_id)))
            .scalars()
            .all()
        )
        assert [(row.note_id, row.project_id) for row in rows] == [(note_id, project_id)]


async def test_deleting_a_note_row_cascades_to_its_links() -> None:
    async with session_scope() as session:
        user = await _create_user(session)
        project = Project(user_id=user.id, name="Launch")
        note = await _note(session, user)
        session.add(project)
        await session.flush()
        session.add(NoteProject(note_id=note.id, project_id=project.id))
        await session.flush()
        note_id, project_id = note.id, project.id

    async with session_scope() as session:
        await session.execute(delete(NoteIndex).where(NoteIndex.id == note_id))

    async with session_scope() as session:
        remaining = await session.scalar(
            select(func.count())
            .select_from(NoteProject)
            .where(NoteProject.project_id == project_id)
        )
        assert remaining == 0


async def test_deleting_a_project_row_cascades_to_its_links() -> None:
    async with session_scope() as session:
        user = await _create_user(session)
        project = Project(user_id=user.id, name="Launch")
        note = await _note(session, user)
        session.add(project)
        await session.flush()
        session.add(NoteProject(note_id=note.id, project_id=project.id))
        await session.flush()
        project_id, note_id = project.id, note.id

    async with session_scope() as session:
        await session.execute(delete(Project).where(Project.id == project_id))

    async with session_scope() as session:
        remaining = await session.scalar(
            select(func.count()).select_from(NoteProject).where(NoteProject.note_id == note_id)
        )
        assert remaining == 0


async def test_deleting_a_user_cascades_to_its_links() -> None:
    async with session_scope() as session:
        user = await _create_user(session)
        project = Project(user_id=user.id, name="Launch")
        note = await _note(session, user)
        session.add(project)
        await session.flush()
        session.add(NoteProject(note_id=note.id, project_id=project.id))
        await session.flush()
        user_id = user.id

    async with session_scope() as session:
        await session.execute(delete(User).where(User.id == user_id))

    async with session_scope() as session:
        remaining = await session.scalar(select(func.count()).select_from(NoteProject))
        assert remaining == 0
