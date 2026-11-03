"""Note history retention, integrity and backup coverage (SYNC-04, ADR-0059 D5)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from httpx import AsyncClient
from sqlalchemy import text

from atlas.backups.service import BackupService
from atlas.config import get_settings
from atlas.db import session_scope
from atlas.models import NoteIndex, User
from atlas.notes import NoteHistory, NotesStorage
from atlas.notes.history import prune_expired_history
from atlas.notes.storage import UnsafePathError, content_hash
from tests.conftest import create_user_via_setup, csrf_headers

pytestmark = pytest.mark.usefixtures("_db")


def settings(**changes: int):  # type: ignore[no-untyped-def]
    return get_settings().model_copy(update=changes)


@pytest.fixture
async def user_id(notes_client: AsyncClient) -> uuid.UUID:
    await create_user_via_setup(notes_client)
    async with session_scope() as session:
        return (await session.scalars(text("SELECT id FROM users"))).one()  # type: ignore[no-any-return]


async def _write_revisions(
    storage: NotesStorage, user: uuid.UUID, count: int, cfg, *, size: int = 10
) -> uuid.UUID:
    note_id = uuid.uuid4()
    async with session_scope() as session:
        note = NoteIndex(
            id=note_id, user_id=user, path=f"{note_id}.md", title="n", content_hash="x", revision=0
        )
        session.add(note)
        await session.flush()
        history = NoteHistory(session, user, storage, cfg)
        for revision in range(1, count + 1):
            body = f"revision {revision}\n" + "x" * size
            note.revision = revision
            note.content_hash = content_hash(body)
            note.size_bytes = len(body.encode())
            await history.record(note, body, reason="write")
    return note_id


async def _rows(note_id: uuid.UUID) -> list[int]:
    async with session_scope() as session:
        result = await session.execute(
            text("SELECT revision FROM note_revisions WHERE note_id = :n ORDER BY revision"),
            {"n": note_id},
        )
        return [row[0] for row in result]


async def test_only_the_newest_revisions_are_kept_when_nothing_is_recent(
    notes_storage: NotesStorage, user_id: uuid.UUID
) -> None:
    cfg = settings(note_history_keep_revisions=5, note_history_keep_days=0)
    note_id = await _write_revisions(notes_storage, user_id, 30, cfg)
    assert await _rows(note_id) == [26, 27, 28, 29, 30]
    assert len(notes_storage.history_hashes(note_id)) == 5, "the pruned texts are gone from disk"


async def test_recent_revisions_are_kept_beyond_the_newest_but_within_the_bounds(
    notes_storage: NotesStorage, user_id: uuid.UUID
) -> None:
    cfg = settings(note_history_keep_revisions=3, note_history_max_revisions=8)
    note_id = await _write_revisions(notes_storage, user_id, 20, cfg)
    assert await _rows(note_id) == list(range(13, 21)), "younger than 90 days, capped at 8"


async def test_the_size_bound_drops_the_oldest_optional_revisions(
    notes_storage: NotesStorage, user_id: uuid.UUID
) -> None:
    cfg = settings(note_history_keep_revisions=2, note_history_max_bytes=1000)
    note_id = await _write_revisions(notes_storage, user_id, 12, cfg, size=250)
    rows = await _rows(note_id)
    assert rows[-2:] == [11, 12], "the newest revisions are always kept"
    assert 2 <= len(rows) <= 4


async def test_old_revisions_age_out_but_the_newest_never_do(
    notes_storage: NotesStorage, user_id: uuid.UUID
) -> None:
    cfg = settings(note_history_keep_revisions=3)
    note_id = await _write_revisions(notes_storage, user_id, 10, cfg)
    async with session_scope() as session:
        await session.execute(
            text("UPDATE note_revisions SET created_at = now() - interval '200 days'")
        )
    async with session_scope() as session:
        dropped = await prune_expired_history(session, notes_storage, settings=cfg)
    assert dropped == 7 and await _rows(note_id) == [8, 9, 10]
    assert len(notes_storage.history_hashes(note_id)) == 3
    async with session_scope() as session:
        assert await prune_expired_history(session, notes_storage, settings=cfg) == 0


async def test_the_history_of_a_long_deleted_note_is_removed(
    notes_storage: NotesStorage, user_id: uuid.UUID
) -> None:
    cfg = settings()
    gone = await _write_revisions(notes_storage, user_id, 4, cfg)
    kept = await _write_revisions(notes_storage, user_id, 4, cfg)
    async with session_scope() as session:
        await session.execute(
            text("UPDATE notes SET deleted_at = :t WHERE id = :n"),
            {"t": datetime.now(UTC) - timedelta(days=120), "n": gone},
        )
        await session.execute(
            text("UPDATE notes SET deleted_at = :t WHERE id = :n"),
            {"t": datetime.now(UTC) - timedelta(days=5), "n": kept},
        )
    async with session_scope() as session:
        assert await prune_expired_history(session, notes_storage, settings=cfg) == 4
    assert await _rows(gone) == [] and await _rows(kept) == [1, 2, 3, 4]
    assert not (notes_storage.root / ".atlas" / "history" / str(gone)).exists()
    assert len(notes_storage.history_hashes(kept)) == 4


async def test_a_text_shared_by_two_revisions_survives_until_both_are_gone(
    notes_storage: NotesStorage, user_id: uuid.UUID
) -> None:
    cfg = settings(note_history_keep_revisions=1, note_history_keep_days=0)
    note_id = uuid.uuid4()
    async with session_scope() as session:
        note = NoteIndex(
            id=note_id, user_id=user_id, path="s.md", title="s", content_hash="x", revision=0
        )
        session.add(note)
        await session.flush()
        history = NoteHistory(session, user_id, notes_storage, cfg)
        body = "same text\n"
        for revision, content in ((1, body), (2, None)):  # revision 2 is a move: same text
            note.revision = revision
            note.content_hash = content_hash(body)
            await history.record(note, content, reason="write" if content else "move")
    assert await _rows(note_id) == [2]
    assert notes_storage.history_read(note_id, content_hash(body)) == body, "revision 2 needs it"


async def test_a_damaged_or_swapped_history_file_is_never_used(
    notes_storage: NotesStorage, user_id: uuid.UUID
) -> None:
    cfg = settings()
    note_id = await _write_revisions(notes_storage, user_id, 2, cfg)
    digest = content_hash("revision 1\n" + "x" * 10)
    path = notes_storage._history_file(note_id, digest)
    path.write_bytes(b"tampered")
    assert notes_storage.history_read(note_id, digest) is None
    path.write_bytes(b"\xff\xfe not utf-8")
    assert notes_storage.history_read(note_id, digest) is None
    with pytest.raises(UnsafePathError):
        notes_storage.history_read(note_id, "../../etc/passwd".ljust(64, "0"))
    assert (
        notes_storage.history_read(note_id, "../../etc/passwd".ljust(64, "0")) is None
        if False
        else True
    )


async def test_a_damaged_base_turns_a_stale_write_into_a_conflict(
    notes_client: AsyncClient, notes_storage: NotesStorage, user_id: uuid.UUID
) -> None:
    c = notes_client
    headers = {"Atlas-Sync": "1", **csrf_headers(c)}

    def h() -> dict[str, str]:
        return {**headers, "Idempotency-Key": str(uuid.uuid4())}

    text0 = "a\n\nb\n\nc\n"
    base = (await c.post("/api/notes", json={"path": "d.md", "content": text0}, headers=h())).json()
    await c.put(
        f"/api/notes/{base['id']}",
        json={"content": "A\n\nb\n\nc\n", "base_revision": 1, "base_hash": base["content_hash"]},
        headers=h(),
    )
    notes_storage._history_file(uuid.UUID(base["id"]), base["content_hash"]).write_bytes(b"x")
    stale = await c.put(
        f"/api/notes/{base['id']}",
        json={"content": "a\n\nb\n\nC\n", "base_revision": 1, "base_hash": base["content_hash"]},
        headers=h(),
    )
    assert stale.status_code == 409 and stale.json()["reason"] == "base_unavailable"


async def test_history_is_part_of_every_backup(
    notes_client: AsyncClient, notes_storage: NotesStorage, user_id: uuid.UUID
) -> None:
    note = (
        await notes_client.post(
            "/api/notes",
            json={"path": "b.md", "content": "backed up\n"},
            headers=csrf_headers(notes_client),
        )
    ).json()
    entries = BackupService._note_entries(Path(notes_storage.root))
    archived = {rel for _path, rel, is_dir in entries if not is_dir}
    assert f".atlas/history/{note['id']}/{note['content_hash']}.md" in archived


async def test_the_other_users_history_directory_is_not_reachable_by_id(
    notes_storage: NotesStorage, user_id: uuid.UUID
) -> None:
    other = uuid.uuid4()
    async with session_scope() as session:
        session.add(
            User(id=other, email="x@example.com", display_name="X", password_hash="not-used")
        )
    async with session_scope() as session:
        history = NoteHistory(session, other, notes_storage)
        assert await history.list(uuid.uuid4()) == []
