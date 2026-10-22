"""Notes service: revision-aware CRUD, indexing, search and links.

This is the only place that combines the filesystem with the metadata index. The
filesystem is authoritative: every write goes to disk first, then the index is updated in
the same transaction.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import PurePosixPath

from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import NoteIndex, NoteLink, NoteTag, Tag
from .markdown import parse
from .storage import NoteFile, NotesStorage, normalize_note_path, normalize_rel_path


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

    async def get(self, note_id: uuid.UUID) -> NoteIndex:
        note = await self.session.scalar(
            select(NoteIndex).where(
                NoteIndex.id == note_id,
                NoteIndex.user_id == self.user_id,
                NoteIndex.deleted_at.is_(None),
            )
        )
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

        file = self.storage.write(normalized, content)
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
        return note

    async def update(self, note_id: uuid.UUID, content: str, base_revision: int) -> NoteIndex:
        note = await self.get(note_id)
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
        note = await self.get(note_id)
        self.storage.delete(note.path)
        note.deleted_at = datetime.now(UTC)
        note.revision += 1
        await self.session.execute(
            update(NoteLink).where(NoteLink.target_note_id == note.id).values(target_note_id=None)
        )
        await self.session.flush()

    async def rename(self, note_id: uuid.UUID, new_path: str) -> NoteIndex:
        note = await self.get(note_id)
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
        return note

    async def create_folder(self, folder: str) -> None:
        self.storage.create_folder(normalize_rel_path(folder))

    async def rename_folder(self, folder: str, new_folder: str) -> int:
        moves = self.storage.move_folder(normalize_rel_path(folder), normalize_rel_path(new_folder))
        for old_path, new_path in moves:
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
        await self.session.flush()
        return len(moves)

    async def delete_folder(self, folder: str) -> None:
        self.storage.delete_folder(normalize_rel_path(folder))

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
