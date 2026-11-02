"""Read-only backup status for the Settings page (MU-08).

Reads the **published** backup sets' manifests from the configured destination; it never writes,
never recomputes checksums (a set can be gigabytes — ``atlas-backup verify`` does that) and never
returns a path, connection string or error text, only counts, timestamps and sizes.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from .manifest import MANIFEST_NAME
from .verify import list_backup_sets, list_incomplete_sets


@dataclass(frozen=True)
class LatestBackup:
    backup_id: str | None
    created_at: datetime | None
    atlas_version: str | None
    database_bytes: int | None
    notes_bytes: int | None


@dataclass(frozen=True)
class DestinationStatus:
    available: bool
    sets: int
    incomplete: int
    latest: LatestBackup | None


def _mapping(value: object) -> dict[str, object]:
    return value if isinstance(value, dict) else {}


def _int_or_none(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _str_or_none(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _parse_time(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def read_destination_status(destination: str | Path) -> DestinationStatus:
    """Summarise the destination without modifying it. Unreadable manifests yield no ``latest``."""
    root = Path(destination).expanduser()
    if not root.is_dir():
        return DestinationStatus(available=False, sets=0, incomplete=0, latest=None)
    try:
        published = list_backup_sets(root)
        incomplete = len(list_incomplete_sets(root))
    except OSError:
        return DestinationStatus(available=False, sets=0, incomplete=0, latest=None)

    latest: LatestBackup | None = None
    if published:
        try:
            raw = json.loads((published[-1] / MANIFEST_NAME).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raw = None
        if isinstance(raw, dict):
            parts = _mapping(raw.get("parts"))
            database = _mapping(parts.get("database"))
            notes = _mapping(parts.get("notes"))
            latest = LatestBackup(
                backup_id=_str_or_none(raw.get("backup_id")),
                created_at=_parse_time(raw.get("created_at")),
                atlas_version=_str_or_none(raw.get("atlas_version")),
                database_bytes=_int_or_none(database.get("bytes")),
                notes_bytes=_int_or_none(notes.get("bytes")),
            )
    return DestinationStatus(
        available=True, sets=len(published), incomplete=incomplete, latest=latest
    )
