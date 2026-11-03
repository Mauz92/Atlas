"""Notes service: revision-aware CRUD, indexing, search and links.

This is the only place that combines the filesystem with the metadata index. The
filesystem is authoritative: every write goes to disk first, then the index is updated in
the same transaction.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import PurePosixPath

from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..changes import (
    ChangeEntityType,
    ChangeOperation,
    ChangeRecorder,
    entity_id_for,
    note_project_link_id,
)
from ..models import NoteIndex, NoteLink, NoteProject, NoteTag, Tag
from .history import NoteHistory
from .markdown import parse
from .merge import merge3
from .portable import MAX_PATH_CHARS, fold
from .storage import (
    NOTE_SUFFIX,
    NoteFile,
    NotesStorage,
    NoteTooLargeError,
    content_hash,
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


class NoteIdExistsError(RuntimeError):
    """A client-chosen id is already taken by a different note (or by another user's)."""


@dataclass(frozen=True)
class NoteCreated:
    """Result of a create: the note and, when the requested path was taken and the server chose
    another (``path_collision``, SYNC_PROTOCOL.md 6.3), the path that was asked for."""

    note: NoteIndex
    requested_path: str | None = None


class NoteConflictError(RuntimeError):
    """The note changed since the client last read it; nothing was overwritten."""

    def __init__(self, current_revision: int, current_hash: str) -> None:
        super().__init__("note has changed since it was read")
        self.current_revision = current_revision
        self.current_hash = current_hash


class NoteEditWinsError(RuntimeError):
    """Sync mode: a delete based on an older revision than the note's is refused (rule 4)."""

    def __init__(self, note: NoteIndex) -> None:
        super().__init__("the note was edited after the revision this delete was based on")
        self.note = note


class NoteDeletedError(RuntimeError):
    """Sync mode: a move of a deleted note; a rename alone does not bring a note back."""


class NoteWriteConflictError(RuntimeError):
    """Sync mode: the write could not be merged. Nothing was applied to the note; the incoming
    text was saved as ``copy`` so it is never lost. The caller must commit (the copy is a side
    effect) and answer ``409 conflict`` with the copy's identity."""

    def __init__(self, reason: str, note: NoteIndex, copy: NoteIndex) -> None:
        super().__init__(f"the note could not be merged ({reason})")
        self.reason = reason
        self.note = note
        self.copy = copy


@dataclass(frozen=True)
class NoteResolution:
    """An automatic resolution made by a sync-mode note write (``SYNC_PROTOCOL.md`` section 9)."""

    rule: str
    detail: str | None = None
    kept_revision: int | None = None


@dataclass
class NoteWrite:
    """Result of a sync-mode note write. ``merged`` means the text now on the server differs
    from what the client sent (the client must replace its file with the returned content)."""

    note: NoteIndex
    merged: bool = False
    resolutions: list[NoteResolution] = field(default_factory=list)


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
        self.history = NoteHistory(session, user_id, storage)

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

    async def get_any(self, note_id: uuid.UUID, *, for_update: bool = False) -> NoteIndex:
        """The caller's note, live **or deleted** (sync mode: an edit of a tombstone revives it)."""
        stmt = select(NoteIndex).where(NoteIndex.id == note_id, NoteIndex.user_id == self.user_id)
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

    async def claim_id(self, client_id: uuid.UUID, path: str, content: str) -> NoteIndex | None:
        """Idempotency by client id (D3): ``None`` if free, the note if this exact create already
        happened (untouched: revision 1, live, same path and bytes), else ``NoteIdExistsError``.

        A replay is matched on the *requested* path or the ``name (2).md`` variants the server may
        have chosen for it, so a retried create after a collision is still recognised.
        """
        existing = await self.session.get(NoteIndex, client_id)
        if existing is None:
            return None
        if (
            existing.user_id != self.user_id
            or existing.deleted_at is not None
            or existing.revision != 1
            or existing.content_hash != content_hash(content)
        ):
            raise NoteIdExistsError(str(client_id))
        wanted = normalize_note_path(path)
        stem = wanted[: -len(NOTE_SUFFIX)]
        if existing.path != wanted and not (
            existing.path.startswith(f"{stem} (") and existing.path.endswith(f"){NOTE_SUFFIX}")
        ):
            raise NoteIdExistsError(str(client_id))
        return existing

    async def create(
        self,
        path: str,
        content: str,
        *,
        client_id: uuid.UUID | None = None,
        on_collision_rename: bool = False,
    ) -> NoteIndex:
        return (
            await self.create_with_info(
                path, content, client_id=client_id, on_collision_rename=on_collision_rename
            )
        ).note

    async def create_with_info(
        self,
        path: str,
        content: str,
        *,
        client_id: uuid.UUID | None = None,
        on_collision_rename: bool = False,
    ) -> NoteCreated:
        """Create a note at ``path``.

        Without ``client_id`` a tombstone at the same path is revived under its old id (today's
        behaviour: task links to the note come back). With a ``client_id`` the note is always a
        *new* row, even where a tombstone sits (the partial unique index, D3). With
        ``on_collision_rename`` (sync mode) a path taken by a live note or a file becomes
        ``name (2).md`` instead of a conflict; the caller reports ``path_collision``.
        """
        normalized = normalize_note_path(path)
        requested: str | None = None
        if on_collision_rename and await self._path_taken(normalized, fold_case=True):
            requested = normalized
            normalized = await self._free_path(normalized, fold_case=True)
        if self.storage.exists(normalized):
            raise NotePathConflictError(normalized)
        rows = list(
            await self.session.scalars(
                select(NoteIndex)
                .where(NoteIndex.user_id == self.user_id, NoteIndex.path == normalized)
                .order_by(NoteIndex.deleted_at.is_not(None), NoteIndex.updated_at.desc())
            )
        )
        if rows and rows[0].deleted_at is None:
            raise NotePathConflictError(normalized)
        existing = rows[0] if rows and client_id is None else None

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
            if client_id is not None:
                note.id = client_id
            self.session.add(note)
        try:
            await self._apply(note, file)
            await self._relink_unresolved()
            await self.session.flush()
        except IntegrityError as exc:
            # A concurrent create with the same client id won; take back the file written above.
            with suppress(OSError):
                self.storage.delete(normalized)
            if client_id is None:
                raise
            raise NoteIdExistsError(str(client_id)) from exc
        await self.history.record(note, content, reason="revive" if existing else "create")
        await self._record_change(note.id, ChangeOperation.UPSERT)
        return NoteCreated(note, requested_path=requested)

    async def _path_taken(
        self, normalized: str, *, fold_case: bool = False, exclude: uuid.UUID | None = None
    ) -> bool:
        """Is ``normalized`` a file on disk or a live note's path? With ``fold_case`` (sync mode,
        ``portable.py``) a path that differs from a live note's only by case or Unicode
        normalisation counts as taken. ``exclude`` is the note being moved (it never collides
        with itself)."""
        if self.storage.exists(normalized):
            return True
        live = await self.get_by_path(normalized)
        if live is not None and live.id != exclude:
            return True
        if not fold_case:
            return False
        wanted = fold(normalized)
        rows = await self.session.execute(
            select(NoteIndex.id, NoteIndex.path).where(
                NoteIndex.user_id == self.user_id, NoteIndex.deleted_at.is_(None)
            )
        )
        return any(row_id != exclude and fold(path) == wanted for row_id, path in rows)

    async def _free_path(self, normalized: str, *, fold_case: bool = False) -> str:
        """``name (2).md``, ``name (3).md`` ... the first path neither on disk nor live."""
        stem = normalized[: -len(NOTE_SUFFIX)]
        for number in range(2, 1000):
            candidate = f"{stem} ({number}){NOTE_SUFFIX}"
            if not await self._path_taken(candidate, fold_case=fold_case):
                return candidate
        raise NotePathConflictError(normalized)

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
            select(NoteIndex)
            .where(NoteIndex.user_id == self.user_id, NoteIndex.path == path)
            .order_by(NoteIndex.deleted_at.is_not(None), NoteIndex.updated_at.desc())
            .limit(1)
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
        await self.history.record(existing, file.content, reason="external")
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
        await self.history.ensure_current(note, current)
        return await self._write_revision(note, content, reason="write")

    async def _write_revision(self, note: NoteIndex, content: str, *, reason: str) -> NoteIndex:
        """Write ``content`` as the note's next revision: file, index, history and feed row."""
        file = self.storage.write(note.path, content)
        note.revision += 1
        await self._apply(note, file)
        await self.session.flush()
        await self.history.record(note, content, reason=reason)
        await self._record_change(note.id, ChangeOperation.UPSERT)
        return note

    # --- sync-mode writes (SYNC-04; SYNC_PROTOCOL.md 6.3) ----------------------------------

    async def update_sync(
        self, note_id: uuid.UUID, content: str, base_revision: int, base_hash: str
    ) -> NoteWrite:
        """A content write from a sync client: ``content`` was edited from the text with
        ``base_hash`` at ``base_revision``.

        * the base is the current revision: an ordinary write;
        * the base is older: the retained base text is looked up, verified against ``base_hash`` and
          three-way merged with the current text. Non-overlapping edits merge; anything uncertain
          (overlap, a base that is no longer retained, front matter from two sides) raises
          :class:`NoteWriteConflictError` after saving the incoming text as a conflict copy - the
          note itself is never overwritten and nothing is lost;
        * the note is deleted: the edit wins (rule 4) and the note comes back, merged the same way
          against its last text.
        """
        note = await self.get_any(note_id, for_update=True)
        if base_revision > note.revision:
            raise NoteConflictError(note.revision, note.content_hash)
        if note.deleted_at is not None:
            return await self._revive(note, content, base_revision, base_hash)

        current = self.storage.read(note.path)
        await self.history.ensure_current(note, current)
        if current.content_hash != note.content_hash:
            # An edit made on the server's file system that the scan has not indexed yet is a
            # revision like any other (reconcile would record it): take it now, so the merge
            # below sees it and the history holds it.
            note.revision += 1
            await self.reindex_note(note, current)
            await self.history.record(note, current.content, reason="external")
            await self._record_change(note.id, ChangeOperation.UPSERT)
        elif base_revision == note.revision:
            if base_hash != note.content_hash:
                raise await self._conflict(note, content, "base_unavailable")
            if content == current.content:
                return NoteWrite(note)
            return NoteWrite(await self._write_revision(note, content, reason="write"))

        base_text = await self.history.content(note.id, base_revision, expect_hash=base_hash)
        if base_text is None:
            raise await self._conflict(note, content, "base_unavailable")
        if content == base_text:
            # The client changed nothing; whatever the server holds now is what it should show.
            return NoteWrite(note, merged=current.content != content)
        merged = merge3(base_text, current.content, content)
        if merged.text is None:
            raise await self._conflict(note, content, merged.reason or "overlap")
        resolution = NoteResolution("note_merged", kept_revision=note.revision)
        if merged.text == current.content:
            # Everything the client did is already there (or it removed nothing the server has).
            return NoteWrite(note, merged=content != merged.text, resolutions=[resolution])
        note = await self._write_revision(note, merged.text, reason="merge")
        return NoteWrite(note, merged=merged.text != content, resolutions=[resolution])

    async def _conflict(self, note: NoteIndex, content: str, reason: str) -> NoteWriteConflictError:
        copy = await self.conflict_copy(note.id, content, portable=True)
        return NoteWriteConflictError(reason, note, copy)

    async def _revive(
        self, note: NoteIndex, content: str, base_revision: int, base_hash: str
    ) -> NoteWrite:
        """An edit of a deleted note brings it back (ADR-0055 rule 4, ADR-0059 D6).

        The text it returns with is the client's edit merged into the note's last text when that is
        retained. If the merge is not clean, the note returns with its last text and the client's
        text is saved beside it as a conflict copy. A note deleted before history existed has no
        retained last text: nothing live is overwritten, so the client's text is taken (its
        earlier text is still in ``.atlas/trash``).
        """
        resolutions = [NoteResolution("edit_wins_over_delete")]
        last = await self.history.content(note.id, note.revision, expect_hash=note.content_hash)
        text, copy_of = content, None
        if last is not None and base_hash != note.content_hash:
            base_text = await self.history.content(note.id, base_revision, expect_hash=base_hash)
            merged = merge3(base_text, last, content) if base_text is not None else None
            if merged is not None and merged.text is not None:
                text = merged.text
                resolutions.append(NoteResolution("note_merged", kept_revision=note.revision))
            else:
                text, copy_of = last, content
        path = note.path
        if await self._path_taken(path, fold_case=True):
            path = await self._free_path(path, fold_case=True)
            resolutions.append(
                NoteResolution("path_collision", detail=f"{note.path} was taken; restored {path}")
            )
        try:
            file = self.storage.write_new(path, text)
        except FileExistsError as exc:
            raise NotePathConflictError(path) from exc
        note.path = path
        note.deleted_at = None
        note.revision += 1
        try:
            await self._apply(note, file)
            await self._relink_unresolved()
            await self.session.flush()
        except IntegrityError as exc:  # a live note took the path since the check
            with suppress(OSError):
                self.storage.delete(path)
            raise NotePathConflictError(path) from exc
        await self.history.record(note, text, reason="revive")
        await self._record_change(note.id, ChangeOperation.UPSERT)
        if copy_of is not None:
            raise await self._conflict(note, copy_of, "overlap")
        return NoteWrite(note, merged=text != content, resolutions=resolutions)

    async def delete_sync(self, note_id: uuid.UUID, base_revision: int) -> bool:
        """Sync-mode delete. A delete based on a revision older than the note's is refused
        (:class:`NoteEditWinsError`): the edit wins, losing a deletion is recoverable and losing an
        edit is not. Deleting a note that is already deleted succeeds. Returns whether a delete
        happened."""
        note = await self.get_any(note_id, for_update=True)
        if note.deleted_at is not None:
            return False
        if base_revision > note.revision:
            raise NoteConflictError(note.revision, note.content_hash)
        current = self.storage.read(note.path)
        if current.content_hash != note.content_hash:
            # an unindexed edit on the server is an edit after any client's base: record it, refuse
            note.revision += 1
            await self.reindex_note(note, current)
            await self.history.record(note, current.content, reason="external")
            await self._record_change(note.id, ChangeOperation.UPSERT)
        if base_revision < note.revision:
            raise NoteEditWinsError(note)
        await self._remove(note)
        return True

    async def rename_sync(self, note_id: uuid.UUID, new_path: str, base_revision: int) -> NoteWrite:
        """Sync-mode move. A move is independent of content, so a stale base is fine; the target
        must be free (``NotePathConflictError``, case and Unicode normalisation included); a note
        another device already moved elsewhere is moved again (the later move wins, logged); a
        deleted note is not revived by a rename (:class:`NoteDeletedError`)."""
        note = await self.get_any(note_id, for_update=True)
        if note.deleted_at is not None:
            raise NoteDeletedError(str(note_id))
        if base_revision > note.revision:
            raise NoteConflictError(note.revision, note.content_hash)
        normalized = normalize_note_path(new_path)
        resolutions: list[NoteResolution] = []
        if base_revision < note.revision and normalized != note.path:
            entry = await self.history.entry(note.id, base_revision)
            if entry is not None and entry.path != note.path:
                resolutions.append(
                    NoteResolution(
                        "path_later_wins",
                        detail=f"was moved to {note.path} elsewhere; now {normalized}",
                        kept_revision=note.revision + 1,
                    )
                )
        if normalized == note.path:
            return NoteWrite(note, resolutions=resolutions)
        if await self._path_taken(normalized, fold_case=True, exclude=note.id):
            raise NotePathConflictError(normalized)
        try:
            return NoteWrite(await self.rename(note.id, normalized), resolutions=resolutions)
        except IntegrityError as exc:
            raise NotePathConflictError(normalized) from exc

    async def conflict_copy(
        self, note_id: uuid.UUID, content: str, *, portable: bool = False
    ) -> NoteIndex:
        """Preserve a conflicting version beside the note instead of overwriting it.

        ``portable`` (sync mode) shortens the name when it would exceed the portable path length
        (``portable.py``): a conflict copy must never be refused for its name.
        """
        note = await self.get(note_id)
        stamp = datetime.now(UTC).strftime("%Y-%m-%d %H%M%S")
        stem = PurePosixPath(note.path).stem
        parent = str(PurePosixPath(note.path).parent)
        prefix = "" if parent == "." else f"{parent}/"
        suffix = 1
        while True:
            tag = f" (conflict {stamp})" if suffix == 1 else f" (conflict {stamp} {suffix})"
            room = MAX_PATH_CHARS - len(prefix) - len(tag) - len(NOTE_SUFFIX)
            name = stem[: max(1, room)] if portable else stem
            candidate = f"{prefix}{name}{tag}{NOTE_SUFFIX}"
            if not self.storage.exists(candidate) and await self.get_by_path(candidate) is None:
                break
            suffix += 1
        return await self.create(candidate, content)

    async def delete(self, note_id: uuid.UUID) -> None:
        note = await self.get(note_id, for_update=True)
        await self._remove(note)

    async def _remove(self, note: NoteIndex) -> None:
        """Move the file to the trash and tombstone the row; the last text is kept in history so
        a later edit of the deleted note (sync mode) can be merged against it."""
        # an unreadable file has no text to keep; the delete itself still proceeds
        with suppress(NoteTooLargeError, UnicodeDecodeError):
            await self.history.ensure_current(note, self.storage.read(note.path))
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
        await self.history.record(note, None, reason="delete")
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
        await self.history.record(note, file.content, reason="move")
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
                    NoteIndex.user_id == self.user_id,
                    NoteIndex.path == old_path,
                    NoteIndex.deleted_at.is_(None),
                )
            )
            await self.session.execute(
                update(NoteIndex)
                .where(
                    NoteIndex.user_id == self.user_id,
                    NoteIndex.path == old_path,
                    NoteIndex.deleted_at.is_(None),
                )
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
        for note_id in moved_ids:
            moved = await self.session.get(NoteIndex, note_id, populate_existing=True)
            if moved is not None:
                await self.history.record(moved, None, reason="move")
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
