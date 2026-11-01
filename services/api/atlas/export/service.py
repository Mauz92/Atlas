"""Full data export service (M9-03).

:class:`ExportService` captures a user's **entire** workspace — notes, tasks and projects (with
their associations) — into one self-describing, verifiable *export set* (see
:mod:`atlas.export.document`). It is the reusable core behind both the ``GET /api/export`` endpoint
and the ``atlas-export`` CLI.

Design points:

* **Open formats.** Notes are written as their genuine Markdown bytes under ``notes/``; the tasks
  and projects reuse the M4-07 ``atlas.project-export`` document (extended additively with the
  user's ``unfiled_tasks``); the notes metadata index (``notes.json``) carries the tags, wiki links
  and note↔project associations. A manifest lists every file with its size and SHA-256.
* **One consistent snapshot.** Every database read happens inside a single **REPEATABLE READ**
  transaction (:meth:`atlas.projects.service.ProjectsService.begin_consistent_read`, reused from
  M4-07/ADR-0026), so the projects/tasks/notes graph is one point in time and cannot tear. Each note
  file is read atomically (Atlas writes notes with a temp-file + ``os.replace``) and its **actual**
  exported bytes are hashed, so ``notes.json`` and the manifest always describe exactly what is in
  the set.
* **Complete, strictly user-scoped.** Every query filters on the caller's ``user_id``; all live
  projects, all live tasks (filed and unfiled) and all live notes are exported — nothing is silently
  omitted. Because this is a *full* export it is intentionally **unbounded** in row count (Atlas'
  stated scale is a single household, ``PRODUCT_SPEC.md`` §7 A1); note **content** is streamed to
  disk one file at a time, so memory does not grow with the number of notes.
* **Nothing is written outside the target directory**, and a failed run leaves no partial set.
"""

from __future__ import annotations

import hashlib
import json
import logging
import shutil
import uuid
import zipfile
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import IO, Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import __version__
from ..models import NoteIndex, NoteLink, NoteProject, NoteTag, Project, Tag, Task
from ..notes import NotesStorage
from ..projects import ZERO_PROGRESS, ProjectExport, ProjectsService, build_document
from . import document as doc
from .verify import ExportVerification, verify_export_set

logger = logging.getLogger("atlas.export")

#: Read buffer for streaming a note file (and hashing it) without loading it whole.
_CHUNK = 1024 * 1024


class ExportError(RuntimeError):
    """Raised when a complete, verified export set cannot be produced."""


@dataclass(frozen=True)
class ExportSet:
    """The outcome of building one export set."""

    export_id: str
    directory: Path
    created_at: datetime
    projects: int
    tasks: int
    notes: int
    note_project_links: int
    manifest: Mapping[str, Any]
    verification: ExportVerification


@dataclass(frozen=True)
class _Collected:
    """The consistent-snapshot rows the document builders consume."""

    projects: Sequence[Project]
    entries: Sequence[ProjectExport]
    unfiled_tasks: Sequence[Task]
    notes: Sequence[NoteIndex]
    tags: Mapping[uuid.UUID, Sequence[str]]
    links: Mapping[uuid.UUID, Sequence[tuple[str, uuid.UUID | None]]]
    projects_by_note: Mapping[uuid.UUID, Sequence[uuid.UUID]]


def zip_export_set(directory: str | Path, fileobj: IO[bytes], *, root: str | None = None) -> int:
    """Write an export set directory into ``fileobj`` as a zip, rooted at ``root`` (default: the
    directory's own name).

    Files are added in sorted order so the archive is reproducible. Returns the number of files
    added (including ``manifest.json``).
    """
    directory = Path(directory)
    prefix = root or directory.name
    entries = sorted(path for path in directory.rglob("*") if path.is_file())
    with zipfile.ZipFile(fileobj, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in entries:
            rel = path.relative_to(directory).as_posix()
            archive.write(path, arcname=f"{prefix}/{rel}")
    return len(entries)


class ExportService:
    """Build one complete, verifiable export set for a single user (M9-03)."""

    def __init__(
        self,
        session: AsyncSession,
        user_id: uuid.UUID,
        storage: NotesStorage,
        *,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self.session = session
        self.user_id = user_id
        self.storage = storage
        self._now = now or (lambda: datetime.now(UTC))

    # --- the run -------------------------------------------------------

    async def build_set(self, target: str | Path) -> ExportSet:
        """Write a complete export set into ``target`` (a new directory) and verify it.

        ``target`` must not exist. On any failure the partially written directory is removed and an
        :class:`ExportError` (or the underlying error) is raised, so a caller never sees a partial
        set presented as complete.
        """
        target = Path(target).expanduser()
        created_at = self._now()
        export_id = f"{created_at.strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:8]}"
        target.mkdir(parents=True, exist_ok=False)
        try:
            collected = await self._collect()

            # Notes first: the exported bytes' real hashes feed the notes index and the manifest.
            note_files, digests = self._write_notes(target, collected.notes)
            note_entries = [
                doc.note_index_entry(
                    note_id=note.id,
                    path=note.path,
                    title=note.title,
                    revision=note.revision,
                    content_hash=digests[note.id][0],
                    size_bytes=digests[note.id][1],
                    tags=collected.tags.get(note.id, ()),
                    links=[
                        doc.note_link_document(target_path, resolved)
                        for target_path, resolved in collected.links.get(note.id, ())
                    ],
                    projects=collected.projects_by_note.get(note.id, ()),
                )
                for note in collected.notes
            ]
            index_bytes = _json_bytes(doc.build_notes_index(note_entries, generated_at=created_at))
            (target / doc.NOTES_INDEX_FILENAME).write_bytes(index_bytes)

            data_document = build_document(
                collected.entries,
                generated_at=created_at,
                truncated=False,
                unfiled_tasks=collected.unfiled_tasks,
            )
            data_bytes = _json_bytes(data_document)
            (target / doc.DATA_FILENAME).write_bytes(data_bytes)

            files = [
                doc.file_record(
                    doc.DATA_FILENAME,
                    sha256=_sha256(data_bytes),
                    size=len(data_bytes),
                ),
                doc.file_record(
                    doc.NOTES_INDEX_FILENAME,
                    sha256=_sha256(index_bytes),
                    size=len(index_bytes),
                ),
                *note_files,
            ]
            total_tasks = sum(len(entry.tasks) for entry in collected.entries) + len(
                collected.unfiled_tasks
            )
            manifest = doc.build_manifest(
                export_id=export_id,
                created_at=created_at,
                atlas_version=__version__,
                files=files,
                contents={
                    "projects": len(collected.projects),
                    "tasks": total_tasks,
                    "notes": len(collected.notes),
                    "note_project_links": sum(
                        len(ids) for ids in collected.projects_by_note.values()
                    ),
                },
            )
            doc.write_manifest(target / doc.MANIFEST_NAME, manifest)

            verification = verify_export_set(target)
            if not verification.ok:
                msg = "export set failed its own integrity check: " + "; ".join(verification.errors)
                raise ExportError(msg)

            return ExportSet(
                export_id=export_id,
                directory=target,
                created_at=created_at,
                projects=len(collected.projects),
                tasks=total_tasks,
                notes=len(collected.notes),
                note_project_links=sum(len(ids) for ids in collected.projects_by_note.values()),
                manifest=manifest,
                verification=verification,
            )
        except BaseException:
            shutil.rmtree(target, ignore_errors=True)
            raise

    # --- snapshot reads ------------------------------------------------

    async def _collect(self) -> _Collected:
        """Read everything for the export inside one REPEATABLE READ transaction."""
        # Reuse the M4-07 consistent-read approach (ADR-0026): end the request's read-only
        # transaction and open a REPEATABLE READ one so every read below is one point in time.
        await ProjectsService(self.session, self.user_id).begin_consistent_read()

        projects = await self._live_projects()
        project_ids = [project.id for project in projects]
        tasks_by_project = await self._tasks_by_project(project_ids)
        unfiled = await self._unfiled_tasks()
        notes = await self._live_notes()
        note_ids = [note.id for note in notes]
        tags = await self._notes_tags(note_ids)
        links = await self._notes_links(note_ids)
        note_links = await self._note_projects(note_ids)
        progress = await ProjectsService(self.session, self.user_id).progress(project_ids)

        notes_by_project: dict[uuid.UUID, list[NoteIndex]] = {}
        projects_by_note: dict[uuid.UUID, list[uuid.UUID]] = {}
        for note_id, project_id in note_links:
            projects_by_note.setdefault(note_id, []).append(project_id)
        notes_by_id = {note.id: note for note in notes}
        for note_id, project_ids_for_note in projects_by_note.items():
            note = notes_by_id.get(note_id)
            if note is None:  # unreachable: links are read for these notes only
                continue
            for project_id in project_ids_for_note:
                notes_by_project.setdefault(project_id, []).append(note)

        entries = [
            ProjectExport(
                project=project,
                tasks=tasks_by_project.get(project.id, ()),
                notes=notes_by_project.get(project.id, ()),
                progress=progress.get(project.id, ZERO_PROGRESS),
            )
            for project in projects
        ]
        return _Collected(
            projects=projects,
            entries=entries,
            unfiled_tasks=unfiled,
            notes=notes,
            tags=tags,
            links=links,
            projects_by_note=projects_by_note,
        )

    async def _live_projects(self) -> list[Project]:
        """The caller's live projects, in capture order (by ``created_at``, ``id``)."""
        rows = await self.session.scalars(
            select(Project)
            .where(Project.user_id == self.user_id, Project.deleted_at.is_(None))
            .order_by(Project.created_at, Project.id)
        )
        return list(rows)

    async def _live_notes(self) -> list[NoteIndex]:
        """The caller's live notes, in path order."""
        rows = await self.session.scalars(
            select(NoteIndex)
            .where(NoteIndex.user_id == self.user_id, NoteIndex.deleted_at.is_(None))
            .order_by(NoteIndex.path)
        )
        return list(rows)

    async def _tasks_by_project(
        self, project_ids: Sequence[uuid.UUID]
    ) -> Mapping[uuid.UUID, Sequence[Task]]:
        """The live tasks of the given projects, grouped by project, in capture order.

        One query for every project (``project_id IN (…)``), so exporting many projects is a fixed
        number of queries rather than a query per project. ``archived`` tasks are included — they
        are real data.
        """
        if not project_ids:
            return {}
        rows = await self.session.scalars(
            select(Task)
            .where(
                Task.user_id == self.user_id,
                Task.deleted_at.is_(None),
                Task.project_id.in_(project_ids),
            )
            .order_by(Task.created_at, Task.id)
        )
        grouped: dict[uuid.UUID, list[Task]] = {}
        for task in rows:
            if task.project_id is None:  # unreachable: the query restricts to the given ids
                continue
            grouped.setdefault(task.project_id, []).append(task)
        return grouped

    async def _unfiled_tasks(self) -> list[Task]:
        """The caller's live tasks that belong to no project, in capture order.

        Membership is optional (M4-02); a full export must include this work, so it is carried in
        the document's additive top-level ``unfiled_tasks`` key.
        """
        rows = await self.session.scalars(
            select(Task)
            .where(
                Task.user_id == self.user_id,
                Task.deleted_at.is_(None),
                Task.project_id.is_(None),
            )
            .order_by(Task.created_at, Task.id)
        )
        return list(rows)

    async def _notes_tags(self, note_ids: Sequence[uuid.UUID]) -> Mapping[uuid.UUID, Sequence[str]]:
        """Each note's tag names, in name order."""
        if not note_ids:
            return {}
        rows = (
            await self.session.execute(
                select(NoteTag.note_id, Tag.name)
                .join(Tag, Tag.id == NoteTag.tag_id)
                .where(NoteTag.note_id.in_(note_ids), Tag.user_id == self.user_id)
                .order_by(NoteTag.note_id, Tag.name)
            )
        ).all()
        grouped: dict[uuid.UUID, list[str]] = {}
        for note_id, name in rows:
            grouped.setdefault(note_id, []).append(name)
        return grouped

    async def _notes_links(
        self, note_ids: Sequence[uuid.UUID]
    ) -> Mapping[uuid.UUID, Sequence[tuple[str, uuid.UUID | None]]]:
        """Each note's outgoing wiki links (target path -> resolved note id), path order."""
        if not note_ids:
            return {}
        rows = (
            await self.session.execute(
                select(NoteLink.source_note_id, NoteLink.target_path, NoteLink.target_note_id)
                .where(NoteLink.source_note_id.in_(note_ids))
                .order_by(NoteLink.source_note_id, NoteLink.target_path)
            )
        ).all()
        grouped: dict[uuid.UUID, list[tuple[str, uuid.UUID | None]]] = {}
        for source_id, target_path, target_id in rows:
            grouped.setdefault(source_id, []).append((str(target_path), target_id))
        return grouped

    async def _note_projects(
        self, note_ids: Sequence[uuid.UUID]
    ) -> Sequence[tuple[uuid.UUID, uuid.UUID]]:
        """The caller's note↔project associations for the given notes (M4-05)."""
        if not note_ids:
            return []
        rows = (
            await self.session.execute(
                select(NoteProject.note_id, NoteProject.project_id)
                .join(Project, Project.id == NoteProject.project_id)
                .where(
                    NoteProject.note_id.in_(note_ids),
                    Project.user_id == self.user_id,
                    Project.deleted_at.is_(None),
                )
                .order_by(NoteProject.note_id)
            )
        ).all()
        return [(note_id, project_id) for note_id, project_id in rows]

    # --- note files ----------------------------------------------------

    def _write_notes(
        self, target: Path, notes: Sequence[NoteIndex]
    ) -> tuple[list[dict[str, Any]], dict[uuid.UUID, tuple[str, int]]]:
        """Copy each note's real bytes under ``notes/``, hashing as it streams.

        Reads through the :class:`NotesStorage` confinement (so a path can never escape the notes
        root) and writes only inside ``target``. Returns the manifest records plus the
        ``{note_id: (sha256, size)}`` of the exact bytes written.
        """
        files: list[dict[str, object]] = []
        digests: dict[uuid.UUID, tuple[str, int]] = {}
        for note in notes:
            rel = doc.safe_record_path(f"{doc.NOTES_DIR}/{note.path}")
            destination = target / rel
            _ensure_within(target, destination)
            source = self.storage.absolute(note.path)
            if not source.is_file():
                msg = f"note file is missing on disk: {note.path}"
                raise ExportError(msg)
            digest, size = _copy_with_hash(source, destination)
            files.append(doc.file_record(rel, sha256=digest, size=size))
            digests[note.id] = (digest, size)
        return files, digests


def _json_bytes(document: Mapping[str, object]) -> bytes:
    """Serialise a document deterministically (sorted keys, indented, trailing newline)."""
    return (json.dumps(document, indent=2, sort_keys=True) + "\n").encode("utf-8")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _copy_with_hash(source: Path, destination: Path) -> tuple[str, int]:
    """Stream ``source`` into ``destination``, returning its SHA-256 and byte size."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    size = 0
    with source.open("rb") as src, destination.open("wb") as dst:
        while chunk := src.read(_CHUNK):
            digest.update(chunk)
            dst.write(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def _ensure_within(root: Path, path: Path) -> None:
    """Refuse to write a path that resolves outside ``root`` (defence in depth)."""
    resolved_root = root.resolve()
    resolved_path = path.resolve()
    if resolved_path != resolved_root and resolved_root not in resolved_path.parents:
        msg = f"refusing to write outside the export set: {path}"
        raise ExportError(msg)


__all__ = ["ExportError", "ExportService", "ExportSet", "zip_export_set"]
