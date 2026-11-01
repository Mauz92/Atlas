"""Full export document, manifest, set verification and CLI (M9-03): no database required.

Exercises the pure serialisation and verification in :mod:`atlas.export` — the versioned, open
export-set contract — plus the ``atlas-export`` CLI's filesystem commands and the OpenAPI surface of
``GET /api/export``. The set is built from plain objects and files on disk (``tmp_path``), so these
tests never touch PostgreSQL or the configured notes root.
"""

from __future__ import annotations

import io
import json
import uuid
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from atlas.backups.manifest import sha256_file
from atlas.export import (
    DATA_FORMAT,
    DATA_VERSION,
    EXPORT_FORMAT,
    EXPORT_VERSION,
    MANIFEST_NAME,
    NOTES_INDEX_FORMAT,
    NOTES_INDEX_VERSION,
    SET_PREFIX,
    build_manifest,
    build_notes_index,
    note_index_entry,
    note_link_document,
    verify_export_set,
    zip_export_set,
)
from atlas.export import cli as export_cli
from atlas.export.document import (
    ManifestError,
    file_record,
    read_manifest,
    safe_record_path,
    write_manifest,
)
from atlas.main import create_app
from atlas.projects import build_document

_CREATED = datetime(2026, 10, 27, 9, 0, 0, tzinfo=UTC)
_EXPORT_ID = "20261027T090000Z-abcd1234"
_SET_NAME = f"{SET_PREFIX}{_EXPORT_ID}"


def _make_set(
    root: Path,
    files: dict[str, bytes],
    *,
    contents: dict[str, int] | None = None,
) -> Path:
    """Write a set directory (``<root>/atlas-export-…``) with a correct manifest for ``files``."""
    root = root / _SET_NAME
    root.mkdir(parents=True, exist_ok=True)
    records = []
    for rel, data in files.items():
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        records.append(file_record(rel, sha256=sha256_file(target), size=len(data)))
    manifest = build_manifest(
        export_id=_EXPORT_ID,
        created_at=_CREATED,
        atlas_version="0.1.0",
        files=records,
        contents=contents or {"projects": 0, "tasks": 0, "notes": 0, "note_project_links": 0},
    )
    write_manifest(root / MANIFEST_NAME, manifest)
    return root


# --- manifest ---------------------------------------------------------------


def test_the_manifest_is_versioned_and_self_describing(tmp_path: Path) -> None:
    root = _make_set(
        tmp_path,
        {"data.json": b"{}\n", "notes.json": b"{}\n", "notes/Note.md": b"# Note\n"},
        contents={"projects": 1, "tasks": 2, "notes": 1, "note_project_links": 1},
    )

    manifest = read_manifest(root / MANIFEST_NAME)

    assert manifest["format"] == EXPORT_FORMAT
    assert manifest["format_version"] == EXPORT_VERSION == 1
    assert manifest["export_id"] == _EXPORT_ID
    assert manifest["created_at"] == "2026-10-27T09:00:00Z"
    assert manifest["tool"] == "atlas-export"
    assert manifest["atlas_version"] == "0.1.0"
    assert manifest["snapshot"] == "repeatable-read"
    assert manifest["contents"] == {
        "projects": 1,
        "tasks": 2,
        "notes": 1,
        "note_project_links": 1,
    }
    assert manifest["integrity"] == {"algorithm": "sha256", "files": 3}


def test_the_manifest_lists_every_file_sorted_with_size_and_checksum(tmp_path: Path) -> None:
    root = _make_set(tmp_path, {"notes/b.md": b"bee", "notes/a.md": b"ay", "data.json": b"{}"})

    manifest = read_manifest(root / MANIFEST_NAME)

    assert [record["path"] for record in manifest["files"]] == [
        "data.json",
        "notes/a.md",
        "notes/b.md",
    ]
    by_path = {record["path"]: record for record in manifest["files"]}
    assert by_path["notes/a.md"]["bytes"] == 2
    assert by_path["notes/a.md"]["sha256"] == sha256_file(root / "notes/a.md")
    # The manifest never lists itself.
    assert all(record["path"] != MANIFEST_NAME for record in manifest["files"])


def test_a_foreign_or_malformed_manifest_is_rejected(tmp_path: Path) -> None:
    path = tmp_path / MANIFEST_NAME
    path.write_text(json.dumps({"format": "atlas-backup", "format_version": 1, "files": []}))
    with pytest.raises(ManifestError):
        read_manifest(path)

    path.write_text(json.dumps({"format": EXPORT_FORMAT, "format_version": 99, "files": []}))
    with pytest.raises(ManifestError):
        read_manifest(path)

    path.write_text("not json")
    with pytest.raises(ManifestError):
        read_manifest(path)

    path.write_text(json.dumps({"format": EXPORT_FORMAT, "format_version": 1}))
    with pytest.raises(ManifestError):
        read_manifest(path)


def test_safe_record_path_rejects_escapes() -> None:
    assert safe_record_path("notes/a.md") == "notes/a.md"
    for unsafe in ("", ".", "..", "/etc/passwd", "../x", "notes/../../x", "a\\b"):
        with pytest.raises(ManifestError):
            safe_record_path(unsafe)
    with pytest.raises(ManifestError):
        safe_record_path(123)


# --- verification -----------------------------------------------------------


def test_a_good_set_verifies(tmp_path: Path) -> None:
    root = _make_set(tmp_path, {"data.json": b"{}\n", "notes/Note.md": b"# hi\n"})

    verification = verify_export_set(root)

    assert verification.ok is True
    assert verification.export_id == _EXPORT_ID
    assert {check.path for check in verification.files} == {"data.json", "notes/Note.md"}
    assert all(check.ok for check in verification.files)


def test_a_tampered_file_fails_verification(tmp_path: Path) -> None:
    root = _make_set(tmp_path, {"notes/Note.md": b"# hi\n"})
    (root / "notes/Note.md").write_bytes(b"# tampered\n")

    verification = verify_export_set(root)

    assert verification.ok is False
    assert any("checksum/size mismatch" in error for error in verification.errors)


def test_a_missing_listed_file_fails_verification(tmp_path: Path) -> None:
    root = _make_set(tmp_path, {"notes/Note.md": b"# hi\n"})
    (root / "notes/Note.md").unlink()

    verification = verify_export_set(root)

    assert verification.ok is False
    assert any("missing file" in error for error in verification.errors)


def test_a_missing_manifest_is_an_incomplete_set(tmp_path: Path) -> None:
    assert verify_export_set(tmp_path / "nope").ok is False

    empty = tmp_path / "empty"
    empty.mkdir()
    verification = verify_export_set(empty)
    assert verification.ok is False
    assert any("manifest" in error for error in verification.errors)


def test_a_manifest_listing_no_files_fails(tmp_path: Path) -> None:
    root = tmp_path / f"{SET_PREFIX}x"
    root.mkdir()
    write_manifest(
        root / MANIFEST_NAME,
        build_manifest(
            export_id=_EXPORT_ID,
            created_at=_CREATED,
            atlas_version="0.1.0",
            files=[],
            contents={},
        ),
    )

    verification = verify_export_set(root)

    assert verification.ok is False
    assert any("lists no files" in error for error in verification.errors)


def test_an_unsafe_path_in_a_manifest_fails(tmp_path: Path) -> None:
    root = _make_set(tmp_path, {"notes/Note.md": b"# hi\n"})
    manifest = read_manifest(root / MANIFEST_NAME)
    manifest["files"][0]["path"] = "../escape.md"
    write_manifest(root / MANIFEST_NAME, manifest)

    verification = verify_export_set(root)

    assert verification.ok is False
    assert any("unsafe" in error for error in verification.errors)


def test_a_manifest_escaping_the_set_fails(tmp_path: Path) -> None:
    root = _make_set(tmp_path, {"notes/Note.md": b"# hi\n"})
    outside = tmp_path / "outside.md"
    outside.write_text("secret")
    manifest = read_manifest(root / MANIFEST_NAME)
    manifest["files"][0]["path"] = "../outside.md"
    manifest["files"][0]["sha256"] = sha256_file(outside)
    manifest["files"][0]["bytes"] = outside.stat().st_size
    write_manifest(root / MANIFEST_NAME, manifest)

    verification = verify_export_set(root)

    assert verification.ok is False
    assert any("unsafe" in error for error in verification.errors)


# --- notes index ------------------------------------------------------------


def test_a_note_index_entry_carries_metadata_but_no_content() -> None:
    note_id = uuid.uuid4()
    project_id = uuid.uuid4()
    entry = note_index_entry(
        note_id=note_id,
        path="Plans/Launch.md",
        title="Launch",
        revision=3,
        content_hash="a" * 64,
        size_bytes=42,
        tags=["planning", "work"],
        links=[note_link_document("Other.md", uuid.uuid4())],
        projects=[project_id],
    )

    assert set(entry) == {
        "id",
        "path",
        "title",
        "revision",
        "content_hash",
        "size_bytes",
        "tags",
        "links",
        "projects",
    }
    assert entry["id"] == str(note_id)
    assert entry["path"] == "Plans/Launch.md"
    assert entry["tags"] == ["planning", "work"]
    assert entry["projects"] == [str(project_id)]
    # The content itself lives in the .md file, never in the index.
    assert "content" not in entry


def test_a_note_link_records_resolved_and_unresolved_targets() -> None:
    resolved = uuid.uuid4()
    assert note_link_document("Note.md", resolved) == {
        "target": "Note.md",
        "note_id": str(resolved),
    }
    assert note_link_document("Missing.md", None) == {"target": "Missing.md", "note_id": None}


def test_the_notes_index_is_versioned() -> None:
    document = build_notes_index([], generated_at=_CREATED)
    assert document["format"] == NOTES_INDEX_FORMAT
    assert document["version"] == NOTES_INDEX_VERSION == 1
    assert document["generated_at"] == "2026-10-27T09:00:00Z"
    assert document["notes"] == []


# --- the reused M4-07 document, extended additively -------------------------


def _task(**overrides: Any) -> SimpleNamespace:
    values: dict[str, Any] = {
        "id": uuid.uuid4(),
        "title": "Unfiled",
        "description": None,
        "status": "inbox",
        "priority": "none",
        "project_id": None,
        "parent_task_id": None,
        "start_at": None,
        "due_at": None,
        "time_zone": None,
        "duration_minutes": None,
        "completed_at": None,
        "recurrence_rule": None,
        "recurrence_parent_id": None,
        "external_provider": None,
        "external_id": None,
        "revision": 1,
        "created_at": _CREATED,
        "updated_at": _CREATED,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_the_full_document_adds_unfiled_tasks_additively() -> None:
    unfiled = _task()
    document = build_document([], generated_at=_CREATED, truncated=False, unfiled_tasks=[unfiled])

    assert document["format"] == DATA_FORMAT == "atlas.project-export"
    assert document["version"] == DATA_VERSION == 1
    assert document["truncated"] is False
    assert [task["id"] for task in document["unfiled_tasks"]] == [str(unfiled.id)]
    assert document["projects"] == []


def test_the_project_export_document_is_unchanged_without_unfiled_tasks() -> None:
    document = build_document([], generated_at=_CREATED, truncated=False)
    assert "unfiled_tasks" not in document
    assert list(document) == ["format", "version", "generated_at", "truncated", "projects"]


def test_the_full_document_can_hold_an_empty_unfiled_list() -> None:
    document = build_document([], generated_at=_CREATED, truncated=False, unfiled_tasks=[])
    assert document["unfiled_tasks"] == []


# --- zip + CLI --------------------------------------------------------------


def test_zip_export_set_roots_files_under_the_given_name(tmp_path: Path) -> None:
    root = _make_set(tmp_path, {"data.json": b"{}\n", "notes/Note.md": b"# hi\n"})

    buffer = io.BytesIO()
    count = zip_export_set(root, buffer, root="atlas-export-xyz")

    assert count == 3
    with zipfile.ZipFile(buffer) as archive:
        assert archive.namelist() == [
            "atlas-export-xyz/data.json",
            "atlas-export-xyz/manifest.json",
            "atlas-export-xyz/notes/Note.md",
        ]
        assert archive.read("atlas-export-xyz/notes/Note.md") == b"# hi\n"


def test_the_cli_verifies_lists_and_flags_incomplete_sets(tmp_path: Path) -> None:
    destination = tmp_path / "exports"
    root = _make_set(destination, {"notes/Note.md": b"# hi\n"})

    assert export_cli.main(["verify", str(root)]) == 0
    assert export_cli.main(["list", str(destination)]) == 0
    assert export_cli.main(["verify", str(destination)]) == 0

    (root / "notes/Note.md").write_bytes(b"tampered")
    assert export_cli.main(["verify", str(root)]) == 1
    assert export_cli.main(["verify", str(destination)]) == 1

    # A leftover staging directory is reported as incomplete.
    (destination / ".staging" / "export-deadbeef").mkdir(parents=True)
    assert export_cli.main(["verify", str(destination)]) == 1


def test_the_cli_reports_no_sets(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert export_cli.main(["verify", str(tmp_path)]) == 1
    assert "no export sets found" in capsys.readouterr().err


# --- OpenAPI surface --------------------------------------------------------


def test_the_export_route_is_registered_read_only() -> None:
    paths = create_app().openapi()["paths"]
    assert set(paths["/api/export"]) == {"get"}
    response = paths["/api/export"]["get"]["responses"]["200"]
    assert "application/zip" in response["content"]
