"""Notes service: revision-aware CRUD, indexing, search and links.

This is the only place that combines the filesystem with the metadata index. The
filesystem is authoritative: every write goes to disk first, then the index is updated in
the same transaction.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import PurePosixPath

from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..changes import (
    ChangeEntityType,
    ChangeOperation,
    ChangeRecorder,
    entity_id_for,
    note_project_link_id,
)
from ..models import NoteIndex, NoteLink, NoteProject, NoteTag, Tag
from .markdown import parse
from .storage import (
    NOTE_SUFFIX,
    NoteFile,
    NotesStorage,
    normalize_note_path,
    normalize_rel_path,
)
from .templates import (
    DAILY_DIR,
    TEMPLATES_DIR,
    TemplateError,
    parse_day,
    render_template,
)


class NoteNotFoundError(LookupError):
    pass


class NotePathConflictError(FileExistsError):
    pass


class NoteConflictError(RuntimeError):
    """The note changed since the client last read it; nothing was overwritten."""

    def __init__(self, current_revision: int, current_hash: str) -> None:
        super().__init__("note has changed since it was read")
        self.current_revision = current_revision
        self.current_hash = current_hash


@dataclass(frozen=True)
class NoteSummary:
    id: uuid.UUID
    path: str
    title: str
    revision: int
    content_hash: str
    size_bytes: int


def _summary(note: NoteIndex) -> NoteSummary:
    return NoteSummary(
        id=note.id,
        path=note.path,
        title=note.title,
        revision=note.revision,
        content_hash=note.content_hash,
        size_bytes=note.size_bytes,
    )


class NotesService:
    def __init__(self, session: AsyncSession, user_id: uuid.UUID, storage: NotesStorage) -> None:
        self.session = session
        self.user_id = user_id
        self.storage = storage

    # --- queries --------------------------------------------------------

    async def get(self, note_id: uuid.UUID, *, for_update: bool = False) -> NoteIndex:
        """The caller's live note, or ``NoteNotFoundError``.

        ``for_update`` takes the row lock and re-reads the latest committed row (R-37): every
        write that bumps ``revision`` uses it so the revision check and the write are one atomic
        step. Lock order is the note row first, then the user's change cursor (``_record_change``).
        """
        stmt = select(NoteIndex).where(
            NoteIndex.id == note_id,
            NoteIndex.user_id == self.user_id,
            NoteIndex.deleted_at.is_(None),
        )
        if for_update:
            stmt = stmt.with_for_update(key_share=True).execution_options(populate_existing=True)
        note = await self.session.scalar(stmt)
        if note is None:
            raise NoteNotFoundError(str(note_id))
        return note

    async def get_by_path(self, path: str) -> NoteIndex | None:
        normalized = normalize_note_path(path)
        note: NoteIndex | None = await self.session.scalar(
            select(NoteIndex).where(
                NoteIndex.user_id == self.user_id,
                NoteIndex.path == normalized,
                NoteIndex.deleted_at.is_(None),
            )
        )
        return note

    async def list_notes(self, folder: str | None = None) -> list[NoteSummary]:
        stmt = select(NoteIndex).where(
            NoteIndex.user_id == self.user_id, NoteIndex.deleted_at.is_(None)
        )
        if folder:
            prefix = normalize_rel_path(folder).rstrip("/")
            stmt = stmt.where(NoteIndex.path.startswith(f"{prefix}/")) if prefix else stmt
        notes = (await self.session.scalars(stmt.order_by(NoteIndex.path))).all()
        return [_summary(note) for note in notes]

    async def list_folders(self) -> list[str]:
        return self.storage.list_folders()

    async def note_tags(self, note_id: uuid.UUID) -> list[str]:
        rows = await self.session.scalars(
            select(Tag.name)
            .join(NoteTag, NoteTag.tag_id == Tag.id)
            .where(NoteTag.note_id == note_id)
            .order_by(Tag.name)
        )
        return list(rows)

    async def outgoing_links(self, note_id: uuid.UUID) -> list[tuple[str, str | None]]:
        rows = (
            await self.session.execute(
                select(NoteLink.target_path, NoteLink.target_note_id)
                .where(NoteLink.source_note_id == note_id)
                .order_by(NoteLink.target_path)
            )
        ).all()
        return [(str(row[0]), str(row[1]) if row[1] else None) for row in rows]

    async def backlinks(self, note_id: uuid.UUID) -> list[NoteSummary]:
        rows = (
            await self.session.scalars(
                select(NoteIndex)
                .join(NoteLink, NoteLink.source_note_id == NoteIndex.id)
                .where(
                    NoteLink.target_note_id == note_id,
                    NoteIndex.deleted_at.is_(None),
                )
                .order_by(NoteIndex.path)
            )
        ).all()
        return [_summary(note) for note in rows]

    async def search(self, query: str, *, limit: int = 50) -> list[NoteSummary]:
        text = query.strip()
        if not text:
            return []
        tsquery = func.plainto_tsquery("english", text)
        stmt = (
            select(NoteIndex)
            .where(
                NoteIndex.user_id == self.user_id,
                NoteIndex.deleted_at.is_(None),
                NoteIndex.search_vector.op("@@")(tsquery),
            )
            .order_by(func.ts_rank(NoteIndex.search_vector, tsquery).desc(), NoteIndex.path)
            .limit(limit)
        )
        notes = (await self.session.scalars(stmt)).all()
        return [_summary(note) for note in notes]

    # --- mutations ------------------------------------------------------

    async def create(self, path: str, content: str) -> NoteIndex:
        normalized = normalize_note_path(path)
        if self.storage.exists(normalized):
            raise NotePathConflictError(normalized)
        existing = await self.session.scalar(
            select(NoteIndex).where(NoteIndex.user_id == self.user_id, NoteIndex.path == normalized)
        )
        if existing is not None and existing.deleted_at is None:
            raise NotePathConflictError(normalized)

        try:
            file = self.storage.write_new(normalized, content)
        except FileExistsError as exc:  # created by someone else since the check above
            raise NotePathConflictError(normalized) from exc
        if existing is not None:
            note = existing
            note.deleted_at = None
            note.revision += 1
        else:
            note = NoteIndex(
                user_id=self.user_id, path=normalized, revision=1, size_bytes=0, content_hash=""
            )
            self.session.add(note)
        await self._apply(note, file)
        await self._relink_unresolved()
        await self.session.flush()
        await self._record_change(note.id, ChangeOperation.UPSERT)
        return note

    async def open_daily(self, day: str) -> tuple[NoteIndex, bool]:
        """Open the daily note for ``day`` (``YYYY-MM-DD``), creating it only if it is missing.

        Idempotent: an existing note is returned untouched, never rewritten, and concurrent calls
        are serialised per path so exactly one creates it. A file that exists on disk but is not
        indexed yet (added outside Atlas) is adopted rather than replaced. Returns the note and
        whether this call created it.
        """
        stamp = parse_day(day)
        path = f"{DAILY_DIR}/{stamp}{NOTE_SUFFIX}"
        await self.session.execute(
            select(func.pg_advisory_xact_lock(func.hashtextextended(f"{self.user_id}:{path}", 0)))
        )
        if self.storage.exists(path):
            return await self._adopt(path), False
        template = f"{TEMPLATES_DIR}/daily{NOTE_SUFFIX}"
        body = f"# {stamp}\n"
        if self.storage.exists(template):
            body = render_template(self.storage.read(template).content, title=stamp, day=stamp)
        return await self.create(path, body), True

    async def create_from_template(
        self, path: str, template_id: uuid.UUID, day: str | None = None
    ) -> NoteIndex:
        """Create a note whose content is a template note with its placeholders substituted."""
        template = await self.get(template_id)
        if PurePosixPath(template.path).parts[0] != TEMPLATES_DIR:
            raise TemplateError(f"a template must be a note in the {TEMPLATES_DIR}/ folder")
        stamp = parse_day(day) if day else datetime.now(UTC).date().isoformat()
        normalized = normalize_note_path(path)
        content = render_template(
            self.storage.read(template.path).content,
            title=PurePosixPath(normalized).stem,
            day=stamp,
        )
        return await self.create(normalized, content)

    async def _adopt(self, path: str) -> NoteIndex:
        """Return the live index row for a file that exists, indexing the file if it has none."""
        existing = await self.session.scalar(
            select(NoteIndex).where(NoteIndex.user_id == self.user_id, NoteIndex.path == path)
        )
        if existing is not None and existing.deleted_at is None:
            return existing
        file = self.storage.read(path)
        if existing is None:
            existing = NoteIndex(
                user_id=self.user_id, path=path, revision=1, size_bytes=0, content_hash="", title=""
            )
            self.session.add(existing)
            await self.session.flush()
        else:
            existing.revision += 1
        await self._apply(existing, file)
        await self._relink_unresolved()
        await self.session.flush()
        await self._record_change(existing.id, ChangeOperation.UPSERT)
        return existing

    async def update(self, note_id: uuid.UUID, content: str, base_revision: int) -> NoteIndex:
        note = await self.get(note_id, for_update=True)
        if note.revision != base_revision:
            raise NoteConflictError(note.revision, note.content_hash)
        current = self.storage.read(note.path)
        if current.content_hash != note.content_hash:
            # The file changed underneath us (external edit); refuse to overwrite it.
            raise NoteConflictError(note.revision, current.content_hash)
        if current.content == content:
            return note
        file = self.storage.write(note.path, content)
        note.revision += 1
        await self._apply(note, file)
        await self.session.flush()
        await self._record_change(note.id, ChangeOperation.UPSERT)
        return note

    async def conflict_copy(self, note_id: uuid.UUID, content: str) -> NoteIndex:
        """Preserve a conflicting version beside the note instead of overwriting it."""
        note = await self.get(note_id)
        stamp = datetime.now(UTC).strftime("%Y-%m-%d %H%M%S")
        stem = PurePosixPath(note.path).stem
        parent = str(PurePosixPath(note.path).parent)
        prefix = "" if parent == "." else f"{parent}/"
        candidate = f"{prefix}{stem} (conflict {stamp}).md"
        suffix = 2
        while self.storage.exists(candidate):
            candidate = f"{prefix}{stem} (conflict {stamp} {suffix}).md"
            suffix += 1
        return await self.create(candidate, content)

    async def delete(self, note_id: uuid.UUID) -> None:
        note = await self.get(note_id, for_update=True)
        self.storage.delete(note.path)
        project_ids = await self.tombstone_index(note)
        await self.announce_removal(note, project_ids)

    async def tombstone_index(self, note: NoteIndex) -> list[uuid.UUID]:
        """Mark a note's index row removed and drop its links; returns the unlinked project ids.

        The single definition of "a note was removed", shared by :meth:`delete` (the API) and the
        reconciler (the file vanished outside Atlas), so both leave identical state. It does not
        touch the file. The wiki-link targets that pointed at the note are cleared; a
        note↔project link is a pure association and is dropped with the note so no dangling
        project membership survives (M4-05, ADR-0024). Task↔note links are kept, so that a note
        that reappears restores them (``atlas.tasks.note_links``). The note row stays as a
        tombstone. The linked project ids are returned so each removal can be announced
        (:meth:`announce_removal`, M7-01). Idempotent: a second call finds no links.
        """
        note.deleted_at = datetime.now(UTC)
        note.revision += 1
        await self.session.execute(
            update(NoteLink).where(NoteLink.target_note_id == note.id).values(target_note_id=None)
        )
        project_ids = list(
            await self.session.scalars(
                select(NoteProject.project_id).where(NoteProject.note_id == note.id)
            )
        )
        await self.session.execute(delete(NoteProject).where(NoteProject.note_id == note.id))
        await self.session.flush()
        return project_ids

    async def announce_removal(self, note: NoteIndex, project_ids: Sequence[uuid.UUID]) -> None:
        """Record the note tombstone and each dropped project link on the change feed."""
        recorder = ChangeRecorder(self.session, self.user_id)
        await recorder.record(ChangeEntityType.NOTE, entity_id_for(note.id), ChangeOperation.DELETE)
        await recorder.record_many(
            (
                ChangeEntityType.NOTE_PROJECT_LINK,
                note_project_link_id(note.id, project_id),
                ChangeOperation.DELETE,
            )
            for project_id in project_ids
        )

    async def rename(self, note_id: uuid.UUID, new_path: str) -> NoteIndex:
        note = await self.get(note_id, for_update=True)
        normalized = normalize_note_path(new_path)
        if normalized == note.path:
            return note
        if self.storage.exists(normalized):
            raise NotePathConflictError(normalized)
        old_path = note.path
        self.storage.move(old_path, normalized)
        note.path = normalized
        note.revision += 1
        await self.session.execute(
            update(NoteLink).where(NoteLink.target_path == old_path).values(target_path=normalized)
        )
        file = self.storage.read(normalized)
        await self._apply(note, file)
        await self._relink_unresolved()
        await self.session.flush()
        await self._record_change(note.id, ChangeOperation.UPSERT)
        return note

    async def create_folder(self, folder: str) -> None:
        self.storage.create_folder(normalize_rel_path(folder))

    async def rename_folder(self, folder: str, new_folder: str) -> int:
        moves = self.storage.move_folder(normalize_rel_path(folder), normalize_rel_path(new_folder))
        moved_ids: list[uuid.UUID] = []
        for old_path, new_path in moves:
            note_id = await self.session.scalar(
                select(NoteIndex.id).where(
                    NoteIndex.user_id == self.user_id, NoteIndex.path == old_path
                )
            )
            await self.session.execute(
                update(NoteIndex)
                .where(NoteIndex.user_id == self.user_id, NoteIndex.path == old_path)
                .values(path=new_path, revision=NoteIndex.revision + 1)
            )
            await self.session.execute(
                update(NoteLink)
                .where(NoteLink.target_path == old_path)
                .values(target_path=new_path)
            )
            if note_id is not None:
                moved_ids.append(note_id)
        await self.session.flush()
        # Every note whose path changed is an ordinary metadata update on the change feed (M7-01).
        await ChangeRecorder(self.session, self.user_id).record_many(
            (ChangeEntityType.NOTE, entity_id_for(note_id), ChangeOperation.UPSERT)
            for note_id in moved_ids
        )
        return len(moves)

    async def delete_folder(self, folder: str) -> None:
        self.storage.delete_folder(normalize_rel_path(folder))

    async def _record_change(self, note_id: uuid.UUID, operation: ChangeOperation) -> None:
        """Announce a note-metadata change on the caller's personal change feed (M7-01)."""
        await ChangeRecorder(self.session, self.user_id).record(
            ChangeEntityType.NOTE, entity_id_for(note_id), operation
        )

    # --- indexing -------------------------------------------------------

    async def reindex_note(self, note: NoteIndex, file: NoteFile) -> None:
        await self._apply(note, file)
        await self._relink_unresolved()
        await self.session.flush()

    async def _apply(self, note: NoteIndex, file: NoteFile) -> None:
        parsed = parse(file.content, file.path)
        note.title = parsed.title or PurePosixPath(file.path).stem
        note.content_hash = file.content_hash
        note.size_bytes = file.size_bytes
        note.deleted_at = None
        await self.session.flush()
        await self.session.execute(
            update(NoteIndex)
            .where(NoteIndex.id == note.id)
            .values(search_vector=func.to_tsvector("english", f"{note.title}\n{file.content}"))
        )
        await self._replace_tags(note, parsed.tags)
        await self._replace_links(note, parsed.links)

    async def _replace_tags(self, note: NoteIndex, tags: list[str]) -> None:
        await self.session.execute(delete(NoteTag).where(NoteTag.note_id == note.id))
        if not tags:
            return
        for name in tags:
            await self.session.execute(
                pg_insert(Tag)
                .values(id=uuid.uuid4(), user_id=self.user_id, name=name)
                .on_conflict_do_nothing(index_elements=["user_id", "name"])
            )
        tag_ids = (
            await self.session.scalars(
                select(Tag.id).where(Tag.user_id == self.user_id, Tag.name.in_(tags))
            )
        ).all()
        for tag_id in tag_ids:
            await self.session.execute(
                pg_insert(NoteTag)
                .values(note_id=note.id, tag_id=tag_id)
                .on_conflict_do_nothing(index_elements=["note_id", "tag_id"])
            )

    async def _replace_links(self, note: NoteIndex, targets: list[str]) -> None:
        await self.session.execute(delete(NoteLink).where(NoteLink.source_note_id == note.id))
        for target in targets:
            resolved = await self._resolve_target(target)
            self.session.add(
                NoteLink(
                    source_note_id=note.id,
                    target_path=target,
                    target_note_id=resolved,
                    link_text=target,
                )
            )

    async def _resolve_target(self, target_path: str) -> uuid.UUID | None:
        direct = await self.session.scalar(
            select(NoteIndex.id).where(
                NoteIndex.user_id == self.user_id,
                NoteIndex.path == target_path,
                NoteIndex.deleted_at.is_(None),
            )
        )
        if direct is not None:
            return direct
        name = PurePosixPath(target_path).name
        matches = (
            await self.session.scalars(
                select(NoteIndex.id).where(
                    NoteIndex.user_id == self.user_id,
                    NoteIndex.deleted_at.is_(None),
                    (NoteIndex.path == name) | NoteIndex.path.endswith(f"/{name}"),
                )
            )
        ).all()
        return matches[0] if len(matches) == 1 else None

    async def _relink_unresolved(self) -> None:
        unresolved = (
            await self.session.execute(
                select(NoteLink.id, NoteLink.target_path)
                .join(NoteIndex, NoteIndex.id == NoteLink.source_note_id)
                .where(
                    NoteLink.target_note_id.is_(None),
                    NoteIndex.user_id == self.user_id,
                )
            )
        ).all()
        for link_id, target_path in unresolved:
            resolved = await self._resolve_target(str(target_path))
            if resolved is not None:
                await self.session.execute(
                    update(NoteLink).where(NoteLink.id == link_id).values(target_note_id=resolved)
                )
