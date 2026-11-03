"""Reconcile the metadata index with the filesystem.

The filesystem is authoritative. A hash-based scan is the reliable mechanism (ADR-0010);
filesystem notifications would only be an optimisation on top of it.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..changes import ChangeEntityType, ChangeOperation, ChangeRecorder, entity_id_for
from ..models import NoteIndex
from .service import NotesService
from .storage import NoteFile, NotesStorage, NoteTooLargeError, UnsafePathError

logger = logging.getLogger("atlas.notes")


@dataclass
class ReconcileSummary:
    added: int = 0
    updated: int = 0
    removed: int = 0
    unchanged: int = 0

    @property
    def total(self) -> int:
        return self.added + self.updated + self.removed + self.unchanged


class NotesReconciler:
    def __init__(self, session: AsyncSession, user_id: uuid.UUID, storage: NotesStorage) -> None:
        self.session = session
        self.user_id = user_id
        self.storage = storage
        self.service = NotesService(session, user_id, storage)
        self.recorder = ChangeRecorder(session, user_id)

    async def run(self) -> ReconcileSummary:
        summary = ReconcileSummary()
        # Announcements are collected and recorded after every row change, so this transaction
        # takes its note-row locks first and the user's change cursor last. That is the same order
        # as every API write (entity row, then cursor); announcing as we go would hold the cursor
        # while still needing note rows and could deadlock with a concurrent note edit.
        announce: list[tuple[NoteIndex, ChangeOperation]] = []
        removals: list[tuple[NoteIndex, list[uuid.UUID]]] = []
        files = self._read_all()
        rows = {
            note.path: note
            for note in await self.session.scalars(
                select(NoteIndex).where(NoteIndex.user_id == self.user_id)
            )
        }

        for path, file in files.items():
            note = rows.get(path)
            if note is None:
                note = NoteIndex(
                    user_id=self.user_id,
                    path=path,
                    revision=1,
                    content_hash="",
                    size_bytes=0,
                    title="",
                )
                self.session.add(note)
                await self.session.flush()
                await self.service.reindex_note(note, file)
                announce.append((note, ChangeOperation.UPSERT))
                summary.added += 1
            elif note.deleted_at is not None:
                note.deleted_at = None
                note.revision += 1
                await self.service.reindex_note(note, file)
                announce.append((note, ChangeOperation.UPSERT))
                summary.added += 1
            elif note.content_hash != file.content_hash and await self._still_differs(note, file):
                note.revision += 1
                await self.service.reindex_note(note, file)
                announce.append((note, ChangeOperation.UPSERT))
                summary.updated += 1
            else:
                summary.unchanged += 1

        for path, note in rows.items():
            if path not in files and note.deleted_at is None:
                await self.session.refresh(note, with_for_update={"key_share": True})
                if note.deleted_at is not None:
                    continue  # removed through the API while this scan was running
                # Same state as NotesService.delete: tombstone, links to the note dropped.
                removals.append((note, await self.service.tombstone_index(note)))
                summary.removed += 1

        await self.session.flush()
        for note, operation in announce:
            await self._announce(note, operation)
        for note, project_ids in removals:
            await self.service.announce_removal(note, project_ids)
        return summary

    async def _still_differs(self, note: NoteIndex, file: NoteFile) -> bool:
        """Lock the row and re-check, so a concurrent API write cannot lose its revision bump.

        The scan reads rows without a lock; an API ``PUT`` that committed in between has already
        written this content (its hash now matches) and bumped the revision, and bumping again
        from the stale in-memory value would hand out the same revision for two states (R-37).
        """
        await self.session.refresh(note, with_for_update={"key_share": True})
        return note.deleted_at is None and note.content_hash != file.content_hash

    async def _announce(self, note: NoteIndex, operation: ChangeOperation) -> None:
        """Record the revision bump on the change feed, in this transaction (SYNC-01).

        An external edit, addition, removal or revival is an ordinary note change: without this a
        client pulling ``/api/changes`` would never learn of it. It is called only for rows the scan
        actually changed, so a scan that finds nothing leaves the cursor untouched and repeated
        scans are idempotent.
        """
        await self.recorder.record(ChangeEntityType.NOTE, entity_id_for(note.id), operation)

    def _read_all(self) -> dict[str, NoteFile]:
        found: dict[str, NoteFile] = {}
        for path in self.storage.list_notes():
            try:
                found[path] = self.storage.read(path)
            except (NoteTooLargeError, UnicodeDecodeError, OSError, UnsafePathError) as exc:
                logger.warning("skipping unreadable note", extra={"path": path, "error": str(exc)})
        return found
