"""Unit tests for the backup-set format, integrity check and pg_dump command builder (M9-01).

These run without a database: they exercise the manifest/checksum logic and the *construction* of
the dump command (including that the password never reaches argv).
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from atlas.backups import (
    BackupConfig,
    ManifestError,
    PgDumpBackend,
    PgDumpError,
    build_dump_argv,
    resolve_backend,
    verify_backup_set,
)
from atlas.backups.manifest import (
    DATABASE_FILENAME,
    DATABASE_PART,
    MANIFEST_NAME,
    NOTES_FILENAME,
    NOTES_PART,
    build_manifest,
    part_filename,
    part_record,
    read_manifest,
    write_manifest,
)


def _write_good_set(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    database = root / DATABASE_FILENAME
    database.write_bytes(b"-- atlas dump\nSELECT 1;\n")
    notes = root / NOTES_FILENAME
    notes.write_bytes(b"fake-notes-archive-bytes")
    parts = {
        DATABASE_PART: part_record(store="postgresql", file=DATABASE_FILENAME, path=database),
        NOTES_PART: part_record(
            store="markdown", file=NOTES_FILENAME, path=notes, extra={"files": 1}
        ),
    }
    write_manifest(
        root / MANIFEST_NAME,
        build_manifest(
            backup_id="20260101T000000Z-deadbeef",
            created_at=datetime(2026, 1, 1, tzinfo=UTC),
            atlas_version="0.1.0",
            parts=parts,
        ),
    )
    return root


# --- the manifest -------------------------------------------------------------


def test_manifest_round_trips_and_records_provenance(tmp_path: Path) -> None:
    root = _write_good_set(tmp_path / "set")
    manifest = read_manifest(root / MANIFEST_NAME)
    assert manifest["format"] == "atlas-backup"
    assert manifest["parts"]["database"]["store"] == "postgresql"
    assert manifest["parts"]["notes"]["store"] == "markdown"
    assert manifest["created_at"] == "2026-01-01T00:00:00+00:00"


def test_a_missing_or_malformed_manifest_is_rejected(tmp_path: Path) -> None:
    root = _write_good_set(tmp_path / "set")
    (root / MANIFEST_NAME).write_text("{ not json", encoding="utf-8")
    with pytest.raises(ValueError):
        read_manifest(root / MANIFEST_NAME)


def test_part_filename_rejects_path_components() -> None:
    assert part_filename({"file": "database.sql"}) == "database.sql"
    for bad in ["../escape.sql", "sub/dir.sql", "", ".", ".."]:
        with pytest.raises(ManifestError):
            part_filename({"file": bad})


# --- the integrity check ------------------------------------------------------


def test_a_good_set_verifies(tmp_path: Path) -> None:
    root = _write_good_set(tmp_path / "set")
    verification = verify_backup_set(root)
    assert verification.ok, verification.errors
    assert {part.name for part in verification.parts} == {DATABASE_PART, NOTES_PART}
    assert all(part.ok for part in verification.parts)


def test_a_tampered_part_fails_verification(tmp_path: Path) -> None:
    root = _write_good_set(tmp_path / "set")
    database = root / DATABASE_FILENAME
    database.write_bytes(database.read_bytes() + b"\n-- tampered\n")
    verification = verify_backup_set(root)
    assert not verification.ok
    assert any("database" in error for error in verification.errors)


def test_a_missing_part_fails_verification(tmp_path: Path) -> None:
    root = _write_good_set(tmp_path / "set")
    (root / NOTES_FILENAME).unlink()
    verification = verify_backup_set(root)
    assert not verification.ok
    assert any("notes" in error for error in verification.errors)


def test_a_missing_manifest_marks_a_set_incomplete(tmp_path: Path) -> None:
    root = _write_good_set(tmp_path / "set")
    (root / MANIFEST_NAME).unlink()
    verification = verify_backup_set(root)
    assert not verification.ok
    assert any("incomplete" in error for error in verification.errors)


def test_an_unsafe_part_filename_in_a_manifest_fails(tmp_path: Path) -> None:
    root = _write_good_set(tmp_path / "set")
    manifest = json.loads((root / MANIFEST_NAME).read_text(encoding="utf-8"))
    manifest["parts"]["notes"]["file"] = "../outside.tar.gz"
    (root / MANIFEST_NAME).write_text(json.dumps(manifest), encoding="utf-8")
    verification = verify_backup_set(root)
    assert not verification.ok
    assert any("notes" in error for error in verification.errors)


# --- the pg_dump command builder ----------------------------------------------


def test_binary_backend_keeps_the_password_out_of_argv() -> None:
    invocation = build_dump_argv(
        "postgresql+psycopg://atlas:hunter2@127.0.0.1:5432/atlas_test",
        PgDumpBackend(kind="binary", target="/usr/bin/pg_dump"),
    )
    assert invocation.argv[0] == "/usr/bin/pg_dump"
    assert "--dbname" in invocation.argv and "atlas_test" in invocation.argv
    assert "--host" in invocation.argv and "127.0.0.1" in invocation.argv
    assert not any("hunter2" in arg for arg in invocation.argv)
    assert "hunter2" not in invocation.display
    assert invocation.env == {"PGPASSWORD": "hunter2"}


def test_container_backend_runs_pg_dump_inside_the_container() -> None:
    invocation = build_dump_argv(
        "postgresql+psycopg://atlas:atlas@db:5432/atlas",
        PgDumpBackend(kind="container", target="atlas-db-1"),
    )
    assert invocation.argv[:4] == ["docker", "exec", "atlas-db-1", "pg_dump"]
    assert "-U" in invocation.argv and "atlas" in invocation.argv
    assert "-d" in invocation.argv
    assert invocation.env == {}
    assert "password" not in invocation.display.lower()


def test_resolve_backend_reports_a_missing_client() -> None:
    with pytest.raises(PgDumpError):
        resolve_backend(binary="definitely-not-a-real-pg-dump-binary")


# --- config validation --------------------------------------------------------


def test_retention_must_be_positive(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        BackupConfig(
            destination=tmp_path / "b",
            notes_root=tmp_path / "n",
            database_url="postgresql+psycopg://atlas:atlas@localhost/atlas",
            retain=0,
        )
