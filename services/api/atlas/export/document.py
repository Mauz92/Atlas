"""Full data export: the set layout, the notes index and the manifest (M9-03).

This module is the **stable, open contract** for a full export of a user's data (REQ-015 data
portability). It is deliberately pure: it takes already-loaded rows (or their extracted values) and
produces plain ``dict`` documents, so the exact shape is unit-testable without a database or a
filesystem. The database reads and the file writes live in
:meth:`atlas.export.service.ExportService.build_set`.

**A full export is a *set* — a directory** (mirroring the M9-01 backup set, ADR-0041):

.. code-block:: text

    atlas-export-<UTC-timestamp>-<id>/
      manifest.json     # this export's record (format + version, file list, sizes, checksums)
      data.json         # the M4-07 document (`atlas.project-export` v1) + `unfiled_tasks`
      notes.json        # the notes metadata index (`atlas.notes-index` v1): tags/links/projects
      notes/            # the notes themselves — real `.md` files at their workspace paths

The three stores are captured in **open formats**: the notes are the genuine Markdown bytes (an
external editor or ``git`` reads them as-is); ``data.json`` is the versioned open JSON document
already defined by M4-07 (ADR-0026), reused not forked, with one additive top-level key
``unfiled_tasks`` holding the tasks that belong to no project (otherwise a full export would
silently omit them); ``notes.json`` carries only *metadata* (never a proprietary wrapper for the
content) so the wiki links, tags and note↔project associations can be reconstructed.

**The manifest** makes the set self-describing and verifiable: it names the format and its version,
records the export id and timestamp, a per-store count and, for every file in the set, its path,
size and SHA-256 (:func:`build_manifest`). Like the backup manifest it contains **no** credential,
connection string or absolute path (``AGENTS.md`` §11).

**Versioning.** ``format`` is a constant that never changes. ``format_version`` starts at ``1`` and
is bumped only for a breaking change to the set layout, recorded in ``DECISIONS.md`` and
``CHANGELOG.md``. Additive changes (a new optional key) do not bump it; a consumer must tolerate
unknown fields.
"""

from __future__ import annotations

import json
import os
import uuid
from collections.abc import Iterable, Sequence
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any

#: The export *set* format identifier (the manifest's marker).
EXPORT_FORMAT = "atlas.full-export"
#: The export set layout version. Bump only for a breaking change.
EXPORT_VERSION = 1

#: The notes metadata-index document.
NOTES_INDEX_FORMAT = "atlas.notes-index"
NOTES_INDEX_VERSION = 1

#: The tasks/projects document is the M4-07 format (ADR-0026), reused and extended additively.
DATA_FORMAT = "atlas.project-export"
DATA_VERSION = 1

MANIFEST_NAME = "manifest.json"
DATA_FILENAME = "data.json"
NOTES_INDEX_FILENAME = "notes.json"
NOTES_DIR = "notes"

#: Directory layout inside the configured export destination (mirrors the backup set).
SET_PREFIX = "atlas-export-"
STAGING_DIR = ".staging"

#: How the tasks/projects snapshot was taken. Recorded so a consumer knows the document is one
#: consistent point in time (M4-07's REPEATABLE READ read, ADR-0026).
SNAPSHOT_REPEATABLE_READ = "repeatable-read"


class ManifestError(ValueError):
    """Raised when an export manifest is missing, unreadable or malformed."""


def _iso_utc(value: datetime) -> str:
    """An instant as ISO-8601 UTC with a ``Z`` suffix (e.g. ``2026-10-27T12:00:00Z``)."""
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _identifier(value: uuid.UUID | None) -> str | None:
    """A UUID as a lower-case string (``None`` stays ``None``)."""
    return None if value is None else str(value)


def note_link_document(target_path: str, target_note_id: uuid.UUID | None) -> dict[str, Any]:
    """One outgoing wiki link: its written target and the resolved note id (or ``None``)."""
    return {"target": target_path, "note_id": _identifier(target_note_id)}


def note_index_entry(
    *,
    note_id: uuid.UUID,
    path: str,
    title: str,
    revision: int,
    content_hash: str,
    size_bytes: int,
    tags: Sequence[str],
    links: Iterable[dict[str, Any]],
    projects: Sequence[uuid.UUID],
) -> dict[str, Any]:
    """One note's metadata in the notes index.

    The **content** is not here: it is the ``.md`` file exported beside this index. ``content_hash``
    and ``size_bytes`` describe the exported bytes exactly (the same values the manifest records),
    so the index and the archive cannot disagree. ``tags``/``links``/``projects`` are the
    associations needed to reconstruct the note graph; ``path`` is the workspace-relative location
    of the exported file under ``notes/``.
    """
    return {
        "id": str(note_id),
        "path": path,
        "title": title,
        "revision": revision,
        "content_hash": content_hash,
        "size_bytes": size_bytes,
        "tags": list(tags),
        "links": list(links),
        "projects": [str(project_id) for project_id in projects],
    }


def build_notes_index(
    entries: Sequence[dict[str, Any]], *, generated_at: datetime
) -> dict[str, Any]:
    """Assemble the notes metadata-index document from already-built note entries."""
    return {
        "format": NOTES_INDEX_FORMAT,
        "version": NOTES_INDEX_VERSION,
        "generated_at": _iso_utc(generated_at),
        "notes": list(entries),
    }


def file_record(path: str, *, sha256: str, size: int) -> dict[str, Any]:
    """One file's manifest record: its within-set path, size and SHA-256."""
    return {"path": path, "bytes": size, "sha256": sha256}


def build_manifest(
    *,
    export_id: str,
    created_at: datetime,
    atlas_version: str,
    files: Iterable[dict[str, Any]],
    contents: dict[str, int],
    snapshot: str = SNAPSHOT_REPEATABLE_READ,
) -> dict[str, Any]:
    """Assemble the manifest document describing one export set.

    ``files`` is sorted by path so a manifest is byte-stable for the same set; the manifest itself
    is never listed among ``files``. ``contents`` records per-store counts (projects, tasks, notes,
    note↔project links) so a consumer can see what the set holds without opening every file.
    """
    ordered = sorted(files, key=lambda record: str(record["path"]))
    return {
        "format": EXPORT_FORMAT,
        "format_version": EXPORT_VERSION,
        "export_id": export_id,
        "created_at": _iso_utc(created_at),
        "tool": "atlas-export",
        "atlas_version": atlas_version,
        "snapshot": snapshot,
        "contents": dict(contents),
        "integrity": {"algorithm": "sha256", "files": len(ordered)},
        "files": ordered,
    }


def write_manifest(path: Path, manifest: dict[str, Any]) -> None:
    """Write the manifest atomically; its presence marks the set complete (as for backups)."""
    text = json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    with tmp.open("rb") as handle:
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def read_manifest(path: Path) -> dict[str, Any]:
    """Load and validate an export manifest's envelope, raising :class:`ManifestError` otherwise."""
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        msg = f"manifest unreadable: {exc}"
        raise ManifestError(msg) from exc
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        msg = f"manifest is not valid JSON: {exc}"
        raise ManifestError(msg) from exc
    if not isinstance(data, dict):
        msg = "manifest must be a JSON object"
        raise ManifestError(msg)
    if data.get("format") != EXPORT_FORMAT:
        msg = "not an Atlas full-export manifest"
        raise ManifestError(msg)
    if data.get("format_version") != EXPORT_VERSION:
        msg = f"unsupported export format version: {data.get('format_version')!r}"
        raise ManifestError(msg)
    if not isinstance(data.get("files"), list):
        msg = "manifest is missing its file list"
        raise ManifestError(msg)
    return data


def safe_record_path(raw: Any) -> str:
    """A record's safe, within-set relative path; rejects anything that could escape the set."""
    if not isinstance(raw, str) or not raw or raw in {".", ".."}:
        msg = f"unsafe export file path: {raw!r}"
        raise ManifestError(msg)
    candidate = PurePosixPath(raw)
    if candidate.is_absolute() or ".." in candidate.parts or "\\" in raw:
        msg = f"unsafe export file path: {raw!r}"
        raise ManifestError(msg)
    return candidate.as_posix()


__all__ = [
    "DATA_FILENAME",
    "DATA_FORMAT",
    "DATA_VERSION",
    "EXPORT_FORMAT",
    "EXPORT_VERSION",
    "MANIFEST_NAME",
    "NOTES_DIR",
    "NOTES_INDEX_FILENAME",
    "NOTES_INDEX_FORMAT",
    "NOTES_INDEX_VERSION",
    "SET_PREFIX",
    "SNAPSHOT_REPEATABLE_READ",
    "STAGING_DIR",
    "ManifestError",
    "build_manifest",
    "build_notes_index",
    "file_record",
    "note_index_entry",
    "note_link_document",
    "read_manifest",
    "safe_record_path",
    "write_manifest",
]
