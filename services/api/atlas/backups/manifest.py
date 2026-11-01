"""Backup-set manifest: what makes a backup set self-describing and verifiable.

A backup set is only *complete* when it contains a ``manifest.json`` whose recorded SHA-256
checksums match the files beside it. The manifest carries provenance (which store each part came
from) and a timestamp, and deliberately contains **no connection strings, credentials or absolute
paths** (AGENTS.md §11): a manifest is safe to store, ship and log.
"""

from __future__ import annotations

import hashlib
import json
import os
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any

#: Marker written into every manifest; a reader refuses anything else.
FORMAT_NAME = "atlas-backup"
FORMAT_VERSION = 1
MANIFEST_NAME = "manifest.json"

#: The two durable stores a complete backup must capture (REQ-015; OPERATIONS.md §1).
DATABASE_PART = "database"
NOTES_PART = "notes"
REQUIRED_PARTS: tuple[str, ...] = (DATABASE_PART, NOTES_PART)
DATABASE_FILENAME = "database.sql"
NOTES_FILENAME = "notes.tar.gz"

#: Directory layout inside the configured backup destination.
SET_PREFIX = "atlas-backup-"
STAGING_DIR = ".staging"


class ManifestError(ValueError):
    """Raised when a manifest is missing, unreadable or malformed."""


def sha256_file(path: Path, *, chunk_size: int = 1024 * 1024) -> str:
    """Stream a file's SHA-256 so large dumps never load into memory."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()


def part_record(
    *,
    store: str,
    file: str,
    path: Path,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Describe one part of a set: which store it came from, its file, size and checksum."""
    record: dict[str, Any] = {
        "store": store,
        "file": file,
        "sha256": sha256_file(path),
        "bytes": path.stat().st_size,
    }
    if extra:
        record.update(extra)
    return record


def build_manifest(
    *,
    backup_id: str,
    created_at: datetime,
    atlas_version: str,
    parts: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    """Assemble the manifest document for a set."""
    return {
        "format": FORMAT_NAME,
        "format_version": FORMAT_VERSION,
        "backup_id": backup_id,
        "created_at": created_at.astimezone(UTC).isoformat(),
        "tool": "atlas-backup",
        "atlas_version": atlas_version,
        "integrity": {"algorithm": "sha256", "parts": sorted(parts)},
        "parts": parts,
    }


def write_manifest(path: Path, manifest: dict[str, Any]) -> None:
    """Write the manifest atomically; its presence is the set's completion marker."""
    text = json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    with tmp.open("rb") as handle:
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def read_manifest(path: Path) -> dict[str, Any]:
    """Load and validate a manifest's envelope, raising :class:`ManifestError` otherwise."""
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
    if data.get("format") != FORMAT_NAME:
        msg = "not an Atlas backup manifest"
        raise ManifestError(msg)
    if data.get("format_version") != FORMAT_VERSION:
        msg = f"unsupported backup format version: {data.get('format_version')!r}"
        raise ManifestError(msg)
    if not isinstance(data.get("parts"), dict):
        msg = "manifest is missing its parts"
        raise ManifestError(msg)
    return data


def part_filename(raw: dict[str, Any]) -> str:
    """A part's safe basename, rejecting any path component supplied by a tampered manifest."""
    name = raw.get("file")
    if not isinstance(name, str) or not name or name in {".", ".."}:
        msg = f"unsafe part filename: {name!r}"
        raise ManifestError(msg)
    if PurePosixPath(name).name != name or "/" in name or "\\" in name:
        msg = f"unsafe part filename: {name!r}"
        raise ManifestError(msg)
    return name
