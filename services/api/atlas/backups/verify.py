"""Integrity check for a backup set (M9-01).

``verify_backup_set`` re-derives every part's SHA-256 from the bytes on disk and compares it with
the manifest. It returns a result rather than raising, so an operator (or a test) can see *why* a
set is bad. A set is good only when **both** stores are present and every checksum matches; a
partial or tampered set is reported as failed so it can never be mistaken for a good backup.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .manifest import (
    MANIFEST_NAME,
    REQUIRED_PARTS,
    SET_PREFIX,
    STAGING_DIR,
    ManifestError,
    part_filename,
    read_manifest,
    sha256_file,
)


@dataclass(frozen=True)
class PartCheck:
    name: str
    file: str | None
    ok: bool
    detail: str
    expected_sha256: str | None = None
    actual_sha256: str | None = None
    expected_bytes: int | None = None
    actual_bytes: int | None = None


@dataclass(frozen=True)
class BackupVerification:
    directory: Path
    backup_id: str | None
    ok: bool
    errors: tuple[str, ...]
    parts: tuple[PartCheck, ...]


def verify_backup_set(directory: str | Path) -> BackupVerification:
    """Verify one backup set directory (both parts present and every checksum matching)."""
    directory = Path(directory)
    if not directory.is_dir():
        return BackupVerification(directory, None, False, (f"not a directory: {directory}",), ())

    manifest_path = directory / MANIFEST_NAME
    if not manifest_path.is_file():
        detail = f"missing {MANIFEST_NAME} (incomplete backup set)"
        return BackupVerification(directory, None, False, (detail,), ())

    try:
        manifest = read_manifest(manifest_path)
    except ManifestError as exc:
        return BackupVerification(directory, None, False, (str(exc),), ())

    raw_id = manifest.get("backup_id")
    backup_id = raw_id if isinstance(raw_id, str) else None
    recorded = manifest["parts"]

    errors: list[str] = []
    parts: list[PartCheck] = []
    for name in REQUIRED_PARTS:
        raw = recorded.get(name)
        if not isinstance(raw, dict):
            errors.append(f"{name}: part not recorded in the manifest")
            parts.append(PartCheck(name, None, False, "part not recorded"))
            continue
        try:
            filename = part_filename(raw)
        except ManifestError as exc:
            errors.append(f"{name}: {exc}")
            parts.append(PartCheck(name, None, False, str(exc)))
            continue

        expected_sha = raw.get("sha256")
        expected_bytes = raw.get("bytes")
        target = directory / filename
        if not target.is_file():
            errors.append(f"{name}: missing file {filename}")
            parts.append(
                PartCheck(
                    name,
                    filename,
                    False,
                    "file missing",
                    expected_sha256=expected_sha,
                    expected_bytes=expected_bytes,
                )
            )
            continue

        actual_bytes = target.stat().st_size
        actual_sha = sha256_file(target)
        ok = actual_sha == expected_sha and actual_bytes == expected_bytes
        detail = "ok" if ok else "checksum/size mismatch"
        if not ok:
            errors.append(f"{name}: {detail}")
        parts.append(
            PartCheck(
                name,
                filename,
                ok,
                detail,
                expected_sha256=expected_sha,
                actual_sha256=actual_sha,
                expected_bytes=expected_bytes,
                actual_bytes=actual_bytes,
            )
        )

    return BackupVerification(directory, backup_id, not errors, tuple(errors), tuple(parts))


def list_backup_sets(destination: str | Path) -> list[Path]:
    """Published (complete) sets under a destination, oldest first (name sorts chronologically)."""
    destination = Path(destination)
    if not destination.is_dir():
        return []
    return sorted(
        path
        for path in destination.iterdir()
        if path.is_dir() and path.name.startswith(SET_PREFIX) and (path / MANIFEST_NAME).is_file()
    )


def list_incomplete_sets(destination: str | Path) -> list[Path]:
    """Leftover staging directories: an interrupted run, never a published set."""
    staging = Path(destination) / STAGING_DIR
    if not staging.is_dir():
        return []
    return sorted(path for path in staging.iterdir() if path.is_dir())
