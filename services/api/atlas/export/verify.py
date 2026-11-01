"""Integrity check for an export set (M9-03).

``verify_export_set`` re-derives every listed file's SHA-256 and size from the bytes on disk and
compares them with the manifest. It returns a result rather than raising, so an operator (or a test)
can see *why* a set is bad. A set is good only when its manifest is present, well-formed and every
file it lists is present with a matching checksum, so a truncated or tampered download can never be
mistaken for a complete export.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ..backups.manifest import sha256_file
from .document import (
    MANIFEST_NAME,
    SET_PREFIX,
    STAGING_DIR,
    ManifestError,
    read_manifest,
    safe_record_path,
)


@dataclass(frozen=True)
class FileCheck:
    """The verification outcome for one file listed in the manifest."""

    path: str
    ok: bool
    detail: str
    expected_sha256: str | None = None
    actual_sha256: str | None = None
    expected_bytes: int | None = None
    actual_bytes: int | None = None


@dataclass(frozen=True)
class ExportVerification:
    """The verification outcome for one export set directory."""

    directory: Path
    export_id: str | None
    ok: bool
    errors: tuple[str, ...]
    files: tuple[FileCheck, ...]


def verify_export_set(directory: str | Path) -> ExportVerification:
    """Verify one export set directory (manifest present and every listed checksum matching)."""
    directory = Path(directory)
    if not directory.is_dir():
        return ExportVerification(directory, None, False, (f"not a directory: {directory}",), ())

    manifest_path = directory / MANIFEST_NAME
    if not manifest_path.is_file():
        detail = f"missing {MANIFEST_NAME} (incomplete export set)"
        return ExportVerification(directory, None, False, (detail,), ())

    try:
        manifest = read_manifest(manifest_path)
    except ManifestError as exc:
        return ExportVerification(directory, None, False, (str(exc),), ())

    raw_id = manifest.get("export_id")
    export_id = raw_id if isinstance(raw_id, str) else None
    recorded = manifest["files"]

    errors: list[str] = []
    checks: list[FileCheck] = []
    if not recorded:
        errors.append("manifest lists no files")
    for raw in recorded:
        try:
            rel = safe_record_path(raw.get("path") if isinstance(raw, dict) else None)
        except ManifestError as exc:
            errors.append(str(exc))
            checks.append(FileCheck(str(raw), False, str(exc)))
            continue

        expected_sha = raw.get("sha256")
        expected_bytes = raw.get("bytes")
        target = directory / rel
        # Defence in depth: a tampered manifest cannot make us read outside the set.
        if directory.resolve() not in target.resolve().parents:
            errors.append(f"{rel}: path escapes the export set")
            checks.append(FileCheck(rel, False, "path escapes the export set"))
            continue
        if not target.is_file():
            errors.append(f"{rel}: missing file")
            checks.append(
                FileCheck(
                    rel,
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
            errors.append(f"{rel}: {detail}")
        checks.append(
            FileCheck(
                rel,
                ok,
                detail,
                expected_sha256=expected_sha,
                actual_sha256=actual_sha,
                expected_bytes=expected_bytes,
                actual_bytes=actual_bytes,
            )
        )

    return ExportVerification(directory, export_id, not errors, tuple(errors), tuple(checks))


def list_export_sets(destination: str | Path) -> list[Path]:
    """Published (complete) export sets under a destination, oldest first (name sorts by time)."""
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


__all__ = [
    "ExportVerification",
    "FileCheck",
    "list_export_sets",
    "list_incomplete_sets",
    "verify_export_set",
]
