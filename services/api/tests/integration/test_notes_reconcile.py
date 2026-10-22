import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from atlas.db import session_scope
from atlas.models import NoteIndex, User
from atlas.notes import NotesReconciler, NotesStorage
from tests.conftest import create_user_via_setup, csrf_headers

pytestmark = pytest.mark.usefixtures("_db")


async def _owner() -> uuid.UUID:
    async with session_scope() as session:
        user = User(
            email=f"{uuid.uuid4().hex}@example.com", display_name="Owner", password_hash="x"
        )
        session.add(user)
        await session.flush()
        return user.id


async def _run_reconciler(storage: NotesStorage, owner: uuid.UUID) -> tuple[int, int, int, int]:
    async with session_scope() as session:
        summary = await NotesReconciler(session, owner, storage).run()
        return summary.added, summary.updated, summary.removed, summary.unchanged


async def test_reconcile_picks_up_new_and_changed_files(notes_storage: NotesStorage) -> None:
    owner = await _owner()
    assert await _run_reconciler(notes_storage, owner) == (0, 0, 0, 0)

    (notes_storage.root / "External.md").write_text("# External\n\nhello\n", encoding="utf-8")
    assert await _run_reconciler(notes_storage, owner) == (1, 0, 0, 0)
    assert await _run_reconciler(notes_storage, owner) == (0, 0, 0, 1)

    (notes_storage.root / "External.md").write_text("# External\n\nchanged\n", encoding="utf-8")
    assert await _run_reconciler(notes_storage, owner) == (0, 1, 0, 0)


async def test_reconcile_indexes_content_for_search(notes_storage: NotesStorage) -> None:
    owner = await _owner()
    (notes_storage.root / "Searchable.md").write_text("# Searchable\n\nzarquon\n", encoding="utf-8")
    await _run_reconciler(notes_storage, owner)

    async with session_scope() as session:
        note = await session.scalar(
            select(NoteIndex).where(NoteIndex.path == "Searchable.md", NoteIndex.user_id == owner)
        )
        assert note is not None
        assert note.search_vector is not None
        assert note.title == "Searchable"
        assert note.revision == 1


async def test_reconcile_marks_missing_files_deleted(notes_storage: NotesStorage) -> None:
    owner = await _owner()
    path = notes_storage.root / "Vanishing.md"
    path.write_text("# Vanishing\n", encoding="utf-8")
    await _run_reconciler(notes_storage, owner)
    (notes_storage.root / "Vanishing.md").unlink()

    assert await _run_reconciler(notes_storage, owner) == (0, 0, 1, 0)

    async with session_scope() as session:
        note = await session.scalar(
            select(NoteIndex).where(NoteIndex.path == "Vanishing.md", NoteIndex.user_id == owner)
        )
        assert note is not None
        assert note.deleted_at is not None


async def test_reconcile_restores_a_previously_deleted_file(notes_storage: NotesStorage) -> None:
    owner = await _owner()
    path = notes_storage.root / "Comeback.md"
    path.write_text("# Comeback\n", encoding="utf-8")
    await _run_reconciler(notes_storage, owner)
    path.unlink()
    await _run_reconciler(notes_storage, owner)

    (notes_storage.root / "Comeback.md").write_text("# Comeback\n\nagain\n", encoding="utf-8")
    assert await _run_reconciler(notes_storage, owner) == (1, 0, 0, 0)

    async with session_scope() as session:
        note = await session.scalar(
            select(NoteIndex).where(NoteIndex.path == "Comeback.md", NoteIndex.user_id == owner)
        )
        assert note is not None
        assert note.deleted_at is None


async def test_reconcile_endpoint(notes_client: AsyncClient, notes_storage: NotesStorage) -> None:
    await create_user_via_setup(notes_client)
    headers = csrf_headers(notes_client)

    (notes_storage.root / "Dropped.md").write_text("# Dropped\n", encoding="utf-8")

    response = await notes_client.post("/api/notes/reconcile", headers=headers)
    assert response.status_code == 200
    assert response.json()["added"] == 1

    listing = await notes_client.get("/api/notes")
    assert [note["path"] for note in listing.json()["notes"]] == ["Dropped.md"]
