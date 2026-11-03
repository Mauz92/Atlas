import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from atlas.changes import ChangesService
from atlas.db import session_scope
from atlas.models import ChangeLog, NoteIndex, User
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


# --- the change feed (SYNC-01 a) -------------------------------------------------


async def _feed(owner: uuid.UUID, since: int = 0) -> list[tuple[str, str, int]]:
    """``(entity_id, operation, cursor)`` of the note changes after ``since``."""
    async with session_scope() as session:
        page = await ChangesService(session, owner).changes(since=since, limit=500)
        return [
            (change.entity_id, change.operation, change.cursor)
            for change in page.changes
            if change.entity_type == "note"
        ]


async def _note_id(owner: uuid.UUID, path: str) -> str:
    async with session_scope() as session:
        note = await session.scalar(
            select(NoteIndex).where(NoteIndex.path == path, NoteIndex.user_id == owner)
        )
        assert note is not None
        return str(note.id)


async def _head(owner: uuid.UUID) -> int:
    async with session_scope() as session:
        return int(await session.scalar(select(User.change_seq).where(User.id == owner)) or 0)


async def test_reconcile_records_added_files_in_the_feed(notes_storage: NotesStorage) -> None:
    owner = await _owner()
    (notes_storage.root / "A.md").write_text("# A\n", encoding="utf-8")
    (notes_storage.root / "B.md").write_text("# B\n", encoding="utf-8")
    await _run_reconciler(notes_storage, owner)

    feed = await _feed(owner)
    assert {(entity_id, op) for entity_id, op, _ in feed} == {
        (await _note_id(owner, "A.md"), "upsert"),
        (await _note_id(owner, "B.md"), "upsert"),
    }
    assert await _head(owner) == 2  # one cursor per changed note, nothing more


async def test_reconcile_records_an_external_edit_once(notes_storage: NotesStorage) -> None:
    owner = await _owner()
    path = notes_storage.root / "Edit.md"
    path.write_text("# Edit\n", encoding="utf-8")
    await _run_reconciler(notes_storage, owner)
    cursor = await _head(owner)

    path.write_text("# Edit\n\nchanged outside Atlas\n", encoding="utf-8")
    await _run_reconciler(notes_storage, owner)

    feed = await _feed(owner, since=cursor)
    assert [(entity_id, op) for entity_id, op, _ in feed] == [
        (await _note_id(owner, "Edit.md"), "upsert")
    ]
    assert feed[0][2] == cursor + 1


async def test_reconcile_records_a_removed_file_as_a_delete(notes_storage: NotesStorage) -> None:
    owner = await _owner()
    path = notes_storage.root / "Gone.md"
    path.write_text("# Gone\n", encoding="utf-8")
    await _run_reconciler(notes_storage, owner)
    cursor = await _head(owner)

    path.unlink()
    await _run_reconciler(notes_storage, owner)

    feed = await _feed(owner, since=cursor)
    assert [(entity_id, op) for entity_id, op, _ in feed] == [
        (await _note_id(owner, "Gone.md"), "delete")
    ]


async def test_reconcile_records_a_revived_file_as_an_upsert(notes_storage: NotesStorage) -> None:
    owner = await _owner()
    path = notes_storage.root / "Back.md"
    path.write_text("# Back\n", encoding="utf-8")
    await _run_reconciler(notes_storage, owner)
    path.unlink()
    await _run_reconciler(notes_storage, owner)
    cursor = await _head(owner)

    path.write_text("# Back\n", encoding="utf-8")
    await _run_reconciler(notes_storage, owner)

    feed = await _feed(owner, since=cursor)
    assert [(entity_id, op) for entity_id, op, _ in feed] == [
        (await _note_id(owner, "Back.md"), "upsert")
    ]


async def test_a_scan_that_finds_nothing_records_nothing(notes_storage: NotesStorage) -> None:
    """Idempotent across repeated scans: no cursor churn, no duplicate rows."""
    owner = await _owner()
    (notes_storage.root / "Stable.md").write_text("# Stable\n", encoding="utf-8")
    await _run_reconciler(notes_storage, owner)
    head = await _head(owner)
    feed_before = await _feed(owner)

    for _ in range(3):
        assert await _run_reconciler(notes_storage, owner) == (0, 0, 0, 1)

    assert await _head(owner) == head
    assert await _feed(owner) == feed_before
    async with session_scope() as session:
        rows = list(await session.scalars(select(ChangeLog).where(ChangeLog.user_id == owner)))
    assert len(rows) == 1


async def test_reconcile_feed_rows_roll_back_with_the_index(notes_storage: NotesStorage) -> None:
    """Same transaction: a scan that fails after recording persists neither index nor feed."""
    owner = await _owner()
    (notes_storage.root / "Rolled.md").write_text("# Rolled\n", encoding="utf-8")

    class _Boom(RuntimeError):
        pass

    with pytest.raises(_Boom):
        async with session_scope() as session:
            summary = await NotesReconciler(session, owner, notes_storage).run()
            assert summary.added == 1
            raise _Boom

    assert await _head(owner) == 0
    assert await _feed(owner) == []
    async with session_scope() as session:
        assert await session.scalar(select(NoteIndex).where(NoteIndex.user_id == owner)) is None
