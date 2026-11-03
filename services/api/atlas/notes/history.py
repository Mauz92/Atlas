"""Note history: retained revisions that serve as the base of a three-way merge (SYNC-04).

ADR-0059 D5, ``SYNC_PROTOCOL.md`` 6.3. Every revision of a note is recorded in ``note_revisions``
(metadata) and its text is stored as a file under ``<notes-root>/.atlas/history/<note_id>/``. The
history is written in the same operation as the revision bump, so a client whose base is any
retained revision can be merged against exactly what it had.

Retention (per note, newest first): the newest ``keep_revisions`` revisions are always kept; an
older one is kept while it is younger than ``keep_days`` and while the note stays within
``max_revisions`` revisions and ``max_bytes`` of distinct text. The bounds make the size of the
history independent of how often a client autosaves. A revision that was pruned is *unavailable*,
and an unavailable base is never merged on a guess: the caller turns the write into a conflict
copy.

Everything here is scoped to one user: a read joins on ``user_id``, a file path contains the note's
own id, and a note id of another user finds no row.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import Settings, get_settings
from ..models import NoteIndex, NoteRevision
from .storage import NoteFile, NotesStorage


@dataclass(frozen=True)
class HistoryEntry:
    revision: int
    content_hash: str
    size_bytes: int
    path: str
    reason: str
    created_at: datetime
    available: bool


class NoteHistory:
    def __init__(
        self,
        session: AsyncSession,
        user_id: uuid.UUID,
        storage: NotesStorage,
        settings: Settings | None = None,
    ) -> None:
        self.session = session
        self.user_id = user_id
        self.storage = storage
        self.settings = settings or get_settings()

    # --- writes -----------------------------------------------------------

    async def record(self, note: NoteIndex, content: str | None, *, reason: str) -> None:
        """Record ``note`` at its current revision (call after the revision was bumped and the
        index row carries the new hash). ``content`` is the text of that revision; ``None`` records
        the row only (the text is the same as a neighbour's, e.g. after a move). Idempotent."""
        await self.session.execute(
            pg_insert(NoteRevision)
            .values(
                note_id=note.id,
                revision=note.revision,
                user_id=self.user_id,
                content_hash=note.content_hash,
                size_bytes=note.size_bytes,
                path=note.path,
                reason=reason,
            )
            .on_conflict_do_nothing(index_elements=["note_id", "revision"])
        )
        if content is not None:
            self.storage.history_write(note.id, content)
        await self.prune_note(note.id)

    async def ensure_current(self, note: NoteIndex, file: NoteFile) -> None:
        """A note written before history existed (or whose text file was lost) has no entry for
        its current revision. The file just read is that revision exactly when its hash equals the
        index hash; then it is recorded now, so the next stale client can be merged against it."""
        if file.content_hash != note.content_hash:
            return
        row = await self.entry(note.id, note.revision)
        if (
            row is not None
            and row.content_hash == note.content_hash
            and self.storage.history_has(note.id, note.content_hash)
        ):
            return
        await self.record(note, file.content, reason="legacy")

    # --- reads ------------------------------------------------------------

    async def entry(self, note_id: uuid.UUID, revision: int) -> NoteRevision | None:
        row: NoteRevision | None = await self.session.scalar(
            select(NoteRevision).where(
                NoteRevision.note_id == note_id,
                NoteRevision.revision == revision,
                NoteRevision.user_id == self.user_id,
            )
        )
        return row

    async def content(
        self, note_id: uuid.UUID, revision: int, *, expect_hash: str | None = None
    ) -> str | None:
        """The text of ``revision``, or ``None`` if it is not retained, damaged, or (when
        ``expect_hash`` is given) not the text the caller thinks it had."""
        row = await self.entry(note_id, revision)
        if row is None or (expect_hash is not None and row.content_hash != expect_hash):
            return None
        return self.storage.history_read(note_id, row.content_hash)

    async def list(self, note_id: uuid.UUID) -> list[HistoryEntry]:
        rows = await self.session.scalars(
            select(NoteRevision)
            .where(NoteRevision.note_id == note_id, NoteRevision.user_id == self.user_id)
            .order_by(NoteRevision.revision.desc())
        )
        return [
            HistoryEntry(
                revision=row.revision,
                content_hash=row.content_hash,
                size_bytes=row.size_bytes,
                path=row.path,
                reason=row.reason,
                created_at=row.created_at,
                available=self.storage.history_has(note_id, row.content_hash),
            )
            for row in rows
        ]

    # --- retention --------------------------------------------------------

    async def prune_note(self, note_id: uuid.UUID, *, now: datetime | None = None) -> int:
        """Apply the retention rules to one note; returns the number of revisions dropped."""
        cfg = self.settings
        now = now or datetime.now(UTC)
        rows = list(
            await self.session.execute(
                select(
                    NoteRevision.revision,
                    NoteRevision.created_at,
                    NoteRevision.content_hash,
                    NoteRevision.size_bytes,
                )
                .where(NoteRevision.note_id == note_id, NoteRevision.user_id == self.user_id)
                .order_by(NoteRevision.revision.desc())
            )
        )
        cutoff = now - timedelta(days=cfg.note_history_keep_days)
        keep: list[tuple[int, str, int]] = []
        for index, (revision, created_at, digest, size) in enumerate(rows):
            if index < cfg.note_history_keep_revisions or created_at >= cutoff:
                keep.append((revision, digest, size))
        # Hard bounds, dropping the oldest of the optional (non-guaranteed) revisions first.
        guaranteed = min(cfg.note_history_keep_revisions, len(keep))

        def distinct_bytes(items: list[tuple[int, str, int]]) -> int:
            return sum({digest: size for _r, digest, size in items}.values())

        while len(keep) > guaranteed and (
            len(keep) > cfg.note_history_max_revisions
            or distinct_bytes(keep) > cfg.note_history_max_bytes
        ):
            keep.pop()
        if len(keep) == len(rows):
            return 0
        kept_revisions = {revision for revision, _digest, _size in keep}
        dropped = [revision for revision, *_rest in rows if revision not in kept_revisions]
        await self.session.execute(
            delete(NoteRevision).where(
                NoteRevision.note_id == note_id, NoteRevision.revision.in_(dropped)
            )
        )
        _sweep(self.storage, note_id, {digest for _r, digest, _s in keep})
        return len(dropped)


async def prune_expired_history(
    session: AsyncSession,
    storage: NotesStorage,
    *,
    settings: Settings | None = None,
    now: datetime | None = None,
) -> int:
    """The periodic sweep (all users; run by the worker with the change purge): revisions older
    than the window beyond each note's newest ``keep_revisions``, and the whole history of a note
    that has been deleted for longer than the window. Returns the number of revisions dropped.
    Safe to repeat. The rows go in the caller's transaction; the files they named are removed
    right after, and a file whose row survived a rollback is simply *unavailable* (never wrong)."""
    cfg = settings or get_settings()
    now = now or datetime.now(UTC)
    cutoff = now - timedelta(days=cfg.note_history_keep_days)
    old = await session.execute(
        text(
            "WITH ranked AS ("
            " SELECT note_id, revision,"
            "  row_number() OVER (PARTITION BY note_id ORDER BY revision DESC) AS rn"
            " FROM note_revisions)"
            " DELETE FROM note_revisions r USING ranked"
            " WHERE r.note_id = ranked.note_id AND r.revision = ranked.revision"
            " AND ranked.rn > :keep AND r.created_at < :cutoff"
            " RETURNING r.note_id"
        ),
        {"keep": cfg.note_history_keep_revisions, "cutoff": cutoff},
    )
    old_ids = [row[0] for row in old]
    dead = await session.execute(
        text(
            "DELETE FROM note_revisions r USING notes n"
            " WHERE r.note_id = n.id AND n.deleted_at IS NOT NULL AND n.deleted_at < :cutoff"
            " RETURNING r.note_id"
        ),
        {"cutoff": cutoff},
    )
    dead_ids = [row[0] for row in dead]
    for note_id in {*old_ids, *dead_ids}:
        remaining = set(
            await session.scalars(
                select(NoteRevision.content_hash).where(NoteRevision.note_id == note_id)
            )
        )
        _sweep(storage, note_id, remaining)
    return len(old_ids) + len(dead_ids)


def _sweep(storage: NotesStorage, note_id: uuid.UUID, keep_hashes: set[str]) -> None:
    """Delete history files no retained row refers to (and the directory once it is empty)."""
    for digest in storage.history_hashes(note_id) - keep_hashes:
        storage.history_delete(note_id, digest)
    if not keep_hashes:
        storage.history_remove_if_empty(note_id)
