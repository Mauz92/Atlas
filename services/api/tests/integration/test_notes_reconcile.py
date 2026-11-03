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


# --- removal behaves like NotesService.delete (SYNC-03) -------------------------------


async def _linked_note(storage: NotesStorage, owner: uuid.UUID, path: str) -> tuple[str, str]:
    """A note on disk and in the index, linked to a project and a task; returns (note, project)."""
    from atlas.models import Project, Task, TaskLink
    from atlas.notes import NotesService
    from atlas.projects import NoteProjectLinks

    async with session_scope() as session:
        stem = path.removesuffix(".md")
        await NotesService(session, owner, storage).create(f"{stem}Target.md", "# Target\n")
        note = await NotesService(session, owner, storage).create(
            path, f"# Linked\n\n[[{stem}Target]]\n"
        )
        # A second note whose wiki link points at the note under test.
        await NotesService(session, owner, storage).create(
            f"{stem}Pointer.md", f"# P\n\n[[{stem}]]\n"
        )
        project = Project(user_id=owner, name="P")
        task = Task(user_id=owner, title="T")
        session.add_all([project, task])
        await session.flush()
        await NoteProjectLinks(session, owner).link(project.id, note.id)
        session.add(TaskLink(task_id=task.id, note_id=note.id))
        return str(note.id), str(project.id)


async def _state(owner: uuid.UUID, note_id: str) -> dict[str, object]:
    from atlas.models import NoteLink, NoteProject, TaskLink

    async with session_scope() as session:
        note = await session.get(NoteIndex, uuid.UUID(note_id))
        assert note is not None
        return {
            "deleted": note.deleted_at is not None,
            "revision": note.revision,
            "project_links": (
                await session.scalars(
                    select(NoteProject.project_id).where(NoteProject.note_id == note.id)
                )
            ).all(),
            "task_links": (
                await session.scalars(select(TaskLink.task_id).where(TaskLink.note_id == note.id))
            ).all(),
            "wiki_targets_pointing_here": (
                await session.scalars(select(NoteLink.id).where(NoteLink.target_note_id == note.id))
            ).all(),
        }


async def test_reconcile_removal_drops_project_links_like_an_api_delete(
    notes_storage: NotesStorage,
) -> None:
    owner = await _owner()
    note_id, project_id = await _linked_note(notes_storage, owner, "Linked.md")
    before = await _state(owner, note_id)
    assert len(before["project_links"]) == 1  # type: ignore[arg-type]
    assert len(before["wiki_targets_pointing_here"]) == 1  # type: ignore[arg-type]
    cursor = await _head(owner)

    (notes_storage.root / "Linked.md").unlink()
    assert await _run_reconciler(notes_storage, owner) == (0, 0, 1, 2)

    state = await _state(owner, note_id)
    assert state["deleted"] is True
    assert list(state["project_links"]) == []  # type: ignore[call-overload]
    # Task links are kept on a tombstoned note (they are restored if the note reappears).
    assert len(state["task_links"]) == 1  # type: ignore[arg-type]

    async with session_scope() as session:
        page = await ChangesService(session, owner).changes(since=cursor, limit=100)
    announced = sorted((c.entity_type, c.entity_id, c.operation) for c in page.changes)
    assert announced == sorted(
        [
            ("note", note_id, "delete"),
            ("note_project_link", f"{note_id}:{project_id}", "delete"),
        ]
    )


async def test_reconcile_removal_matches_notes_service_delete_exactly(
    notes_storage: NotesStorage,
) -> None:
    """Same resulting state whichever path removed the note (the shared tombstone helper)."""
    from atlas.notes import NotesService

    owner = await _owner()
    via_api, _ = await _linked_note(notes_storage, owner, "ViaApi.md")
    via_scan, _ = await _linked_note(notes_storage, owner, "ViaScan.md")
    api_cursor = await _head(owner)

    async with session_scope() as session:
        await NotesService(session, owner, notes_storage).delete(uuid.UUID(via_api))
    api_feed = await _feed(owner, since=api_cursor)
    scan_cursor = await _head(owner)
    (notes_storage.root / "ViaScan.md").unlink()
    await _run_reconciler(notes_storage, owner)

    def shape(state: dict[str, object]) -> tuple[object, ...]:
        return (
            state["deleted"],
            len(state["project_links"]),  # type: ignore[arg-type]
            len(state["task_links"]),  # type: ignore[arg-type]
            len(state["wiki_targets_pointing_here"]),  # type: ignore[arg-type]
        )

    assert shape(await _state(owner, via_api)) == shape(await _state(owner, via_scan))
    assert shape(await _state(owner, via_scan)) == (True, 0, 1, 0)
    assert [(op) for _, op, _ in api_feed] == [op for _, op, _ in await _feed(owner, scan_cursor)]


async def test_reconcile_removal_is_idempotent_across_scans(notes_storage: NotesStorage) -> None:
    owner = await _owner()
    note_id, _ = await _linked_note(notes_storage, owner, "Twice.md")
    (notes_storage.root / "Twice.md").unlink()
    await _run_reconciler(notes_storage, owner)
    head = await _head(owner)
    state = await _state(owner, note_id)

    for _ in range(3):
        assert await _run_reconciler(notes_storage, owner) == (0, 0, 0, 2)

    assert await _head(owner) == head, "no further cursor churn"
    assert await _state(owner, note_id) == state, "no further revision bumps"


async def test_reconcile_removal_rolls_back_links_and_feed_together(
    notes_storage: NotesStorage,
) -> None:
    owner = await _owner()
    note_id, _ = await _linked_note(notes_storage, owner, "Atomic.md")
    head = await _head(owner)
    (notes_storage.root / "Atomic.md").unlink()

    class _Boom(RuntimeError):
        pass

    with pytest.raises(_Boom):
        async with session_scope() as session:
            await NotesReconciler(session, owner, notes_storage).run()
            raise _Boom

    state = await _state(owner, note_id)
    assert state["deleted"] is False and len(state["project_links"]) == 1  # type: ignore[arg-type]
    assert await _head(owner) == head


async def test_reconcile_and_concurrent_note_edits_do_not_deadlock(
    notes_storage: NotesStorage,
) -> None:
    """The scan takes note rows before the change cursor, like every API write (lock order)."""
    import asyncio

    from atlas.notes import NoteConflictError, NotesService

    owner = await _owner()
    ids: list[uuid.UUID] = []
    async with session_scope() as session:
        for n in range(6):
            ids.append(
                (await NotesService(session, owner, notes_storage).create(f"N{n}.md", "# a\n")).id
            )

    async def api_edit(note_id: uuid.UUID, text: str) -> None:
        try:
            async with session_scope() as session:
                service = NotesService(session, owner, notes_storage)
                note = await service.get(note_id)
                await service.update(note_id, text, note.revision)
        except NoteConflictError:
            pass  # the scan or another edit won; losing is fine, deadlocking is not

    for round_ in range(5):
        for n in range(0, 6, 2):  # external edits the scan will pick up
            (notes_storage.root / f"N{n}.md").write_text(f"# ext {round_}\n", encoding="utf-8")
        await asyncio.gather(
            _run_reconciler(notes_storage, owner),
            *(api_edit(ids[n], f"# api {round_}\n") for n in range(1, 6, 2)),
            *(api_edit(ids[n], f"# api {round_}\n") for n in range(0, 6, 2)),
        )
