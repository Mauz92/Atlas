"""Backup production (M9-01).

One run produces one **backup set** capturing *both* durable stores — a plain-SQL PostgreSQL dump
and a deterministic archive of the Markdown notes root — together with a manifest (file list,
sizes, SHA-256 checksums) and an integrity check. The set is assembled in a staging directory and
only published (atomically renamed into the destination) once it has verified itself, so an
interrupted or failed run is always detectable and never presented as a good backup.

Requirements honoured here:

* nothing is ever written outside the configured destination (AGENTS.md §11; CURRENT_TASK M9-01);
* the manifest contains no connection string, credential or absolute path;
* runs are safe to repeat — each produces a fresh set and never mutates an existing one;
* retention prunes only *published* sets, oldest first.
"""

from __future__ import annotations

import gzip
import logging
import os
import shutil
import subprocess
import tarfile
import uuid
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path

from .. import __version__
from ..config import get_settings
from .manifest import (
    DATABASE_FILENAME,
    DATABASE_PART,
    MANIFEST_NAME,
    NOTES_FILENAME,
    NOTES_PART,
    SET_PREFIX,
    STAGING_DIR,
    build_manifest,
    part_record,
    write_manifest,
)
from .pgdump import PgDumpError, build_dump_argv, resolve_backend
from .verify import BackupVerification, list_backup_sets, verify_backup_set

logger = logging.getLogger("atlas.backups")

#: Atlas writes notes atomically through ``.atlas-tmp-*`` files; a backup skips the in-flight ones.
_TEMP_PREFIX = ".atlas-tmp-"
#: A crashed run's staging directory older than this is considered abandoned and cleaned up.
_STAGING_TTL_SECONDS = 24 * 60 * 60


class BackupError(RuntimeError):
    """Raised when a run cannot produce a complete, verified backup set."""


@dataclass(frozen=True)
class BackupConfig:
    destination: Path
    notes_root: Path
    database_url: str
    retain: int = 7
    pg_dump_binary: str = "pg_dump"
    pg_dump_container: str = ""

    def __post_init__(self) -> None:
        if self.retain < 1:
            msg = "retain must be at least 1"
            raise ValueError(msg)


@dataclass(frozen=True)
class BackupResult:
    backup_id: str
    directory: Path
    created_at: datetime
    notes_files: int
    database_bytes: int
    notes_bytes: int
    database_sha256: str
    notes_sha256: str
    verification: BackupVerification


class BackupService:
    """Produce and publish one verifiable backup set per :meth:`run`."""

    def __init__(self, config: BackupConfig, *, now: Callable[[], datetime] | None = None) -> None:
        self._config = config
        self._now = now or (lambda: datetime.now(UTC))

    @classmethod
    def from_settings(cls) -> BackupService:
        settings = get_settings()
        return cls(
            BackupConfig(
                destination=Path(settings.backup_dir).expanduser(),
                notes_root=Path(settings.notes_root).expanduser(),
                database_url=settings.database_url,
                retain=settings.backup_retain,
                pg_dump_binary=settings.backup_pg_dump_binary,
                pg_dump_container=settings.backup_pg_dump_container,
            )
        )

    # --- the run -------------------------------------------------------

    def run(self) -> BackupResult:
        config = self._config
        destination = config.destination.expanduser()
        destination.mkdir(parents=True, exist_ok=True)
        if not destination.is_dir():
            msg = f"backup destination is not a directory: {destination}"
            raise BackupError(msg)

        created_at = self._now()
        backup_id = f"{created_at.strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:8]}"

        staging_root = destination / STAGING_DIR
        staging_root.mkdir(parents=True, exist_ok=True)
        staging = staging_root / backup_id
        staging.mkdir(parents=True, exist_ok=False)

        try:
            database_path = staging / DATABASE_FILENAME
            notes_path = staging / NOTES_FILENAME
            self._dump_database(database_path)
            notes_files = self._archive_notes(notes_path)
            parts = {
                DATABASE_PART: part_record(
                    store="postgresql", file=DATABASE_FILENAME, path=database_path
                ),
                NOTES_PART: part_record(
                    store="markdown",
                    file=NOTES_FILENAME,
                    path=notes_path,
                    extra={"files": notes_files},
                ),
            }
            manifest = build_manifest(
                backup_id=backup_id,
                created_at=created_at,
                atlas_version=__version__,
                parts=parts,
            )
            write_manifest(staging / MANIFEST_NAME, manifest)

            verification = verify_backup_set(staging)
            if not verification.ok:
                msg = "backup set failed its own integrity check: " + "; ".join(verification.errors)
                raise BackupError(msg)

            published = destination / f"{SET_PREFIX}{backup_id}"
            self._ensure_within(destination, published)
            os.replace(staging, published)
            self._prune(destination)

            return BackupResult(
                backup_id=backup_id,
                directory=published,
                created_at=created_at,
                notes_files=notes_files,
                database_bytes=int(parts[DATABASE_PART]["bytes"]),
                notes_bytes=int(parts[NOTES_PART]["bytes"]),
                database_sha256=str(parts[DATABASE_PART]["sha256"]),
                notes_sha256=str(parts[NOTES_PART]["sha256"]),
                verification=replace(verification, directory=published),
            )
        except BaseException:
            # Nothing was published; the staging directory (without a manifest) is left behind as
            # detectable evidence of the failed run (the verifier reports it as incomplete).
            self._remove_if_empty(staging_root)
            raise

    # --- parts ---------------------------------------------------------

    def _dump_database(self, target: Path) -> None:
        config = self._config
        try:
            backend = resolve_backend(
                binary=config.pg_dump_binary, container=config.pg_dump_container
            )
            invocation = build_dump_argv(config.database_url, backend)
        except PgDumpError as exc:
            raise BackupError(str(exc)) from exc

        logger.info("running database dump", extra={"command": invocation.display})
        env = {**os.environ, **invocation.env}
        with target.open("wb") as handle:
            completed = subprocess.run(
                invocation.argv,
                stdout=handle,
                stderr=subprocess.PIPE,
                env=env,
                check=False,
            )
        if completed.returncode != 0:
            stderr = (completed.stderr or b"").decode("utf-8", "replace").strip()
            msg = f"pg_dump failed with exit code {completed.returncode}: {stderr[:500]}"
            raise BackupError(msg)
        if target.stat().st_size == 0:
            msg = "pg_dump produced an empty dump"
            raise BackupError(msg)

    def _archive_notes(self, target: Path) -> int:
        root = self._config.notes_root.expanduser()
        entries = self._note_entries(root)
        # ``mtime=0`` keeps the gzip header deterministic, so unchanged notes archive to the same
        # checksum (a re-run of an idle system is reproducible).
        with (
            target.open("wb") as raw,
            gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as gz,
            tarfile.open(fileobj=gz, mode="w", format=tarfile.GNU_FORMAT) as archive,
        ):
            for path, rel, is_dir in entries:
                info = archive.gettarinfo(str(path), arcname=rel)
                info.uid = 0
                info.gid = 0
                info.uname = ""
                info.gname = ""
                if is_dir:
                    archive.addfile(info)
                else:
                    with path.open("rb") as handle:
                        archive.addfile(info, handle)
        return sum(1 for _path, _rel, is_dir in entries if not is_dir)

    @staticmethod
    def _note_entries(root: Path) -> list[tuple[Path, str, bool]]:
        if not root.is_dir():
            return []
        entries: list[tuple[Path, str, bool]] = []
        for current, dirs, names in os.walk(root):
            dirs[:] = sorted(d for d in dirs if not d.startswith(_TEMP_PREFIX))
            current_path = Path(current)
            for name in dirs:
                folder = current_path / name
                entries.append((folder, folder.relative_to(root).as_posix(), True))
            for name in sorted(names):
                if name.startswith(_TEMP_PREFIX):
                    continue
                note = current_path / name
                entries.append((note, note.relative_to(root).as_posix(), False))
        return entries

    # --- destination hygiene ------------------------------------------

    @staticmethod
    def _ensure_within(destination: Path, target: Path) -> None:
        resolved_destination = destination.resolve()
        resolved_target = target.resolve()
        if resolved_target != resolved_destination and resolved_destination not in (
            resolved_target.parents
        ):
            msg = f"refusing to touch a path outside the destination: {target}"
            raise BackupError(msg)

    def _prune(self, destination: Path) -> None:
        retain = self._config.retain
        published = list_backup_sets(destination)  # oldest first
        for old in published[:-retain]:  # keep the newest ``retain``; drop the oldest
            self._ensure_within(destination, old)
            shutil.rmtree(old, ignore_errors=True)

        staging = destination / STAGING_DIR
        if staging.is_dir():
            cutoff = self._now().timestamp() - _STAGING_TTL_SECONDS
            for leftover in staging.iterdir():
                try:
                    if leftover.is_dir() and leftover.stat().st_mtime < cutoff:
                        self._ensure_within(destination, leftover)
                        shutil.rmtree(leftover, ignore_errors=True)
                except OSError:  # pragma: no cover - racy filesystem state
                    continue
            self._remove_if_empty(staging)

    @staticmethod
    def _remove_if_empty(path: Path) -> None:
        try:
            if path.is_dir() and not any(path.iterdir()):
                path.rmdir()
        except OSError:  # pragma: no cover - racy filesystem state
            pass
