"""Full data export over HTTP and the CLI against a real PostgreSQL (M9-03).

Covers the M9-03 acceptance criteria: one export captures **notes + tasks + projects** (and their
associations) in open formats with a manifest; the notes are the real Markdown bytes; the
tasks/projects reuse the versioned M4-07 document; the manifest lists and verifies every file; the
empty case is handled; and the export is strictly user-scoped. Requires a database and a temp notes
root (``notes_client`` pulls in both).
"""

from __future__ import annotations

import io
import json
import uuid
import zipfile
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any

from sqlalchemy import text

from atlas.db import session_scope
from atlas.export import ExportService, verify_export_set
from atlas.export import cli as export_cli
from atlas.models import NoteIndex, NoteProject, Project, ProjectStatus, Task, User
from atlas.notes import NotesStorage
from tests.conftest import create_user_via_setup, csrf_headers

if TYPE_CHECKING:
    from httpx import AsyncClient

_LINK_CONTENT = "# Launch\n\ntags: #planning #work\n\nSee [[Other]] for context.\n"


async def _auth(client: AsyncClient) -> dict[str, str]:
    await create_user_via_setup(client)
    return csrf_headers(client)


async def _project(
    client: AsyncClient, headers: dict[str, str], name: str = "Project", **extra: Any
) -> dict:
    response = await client.post("/api/projects", json={"name": name, **extra}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


async def _task(
    client: AsyncClient, headers: dict[str, str], title: str = "Task", **payload: Any
) -> dict:
    response = await client.post("/api/tasks", json={"title": title, **payload}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


async def _note(
    client: AsyncClient,
    headers: dict[str, str],
    path: str = "Note.md",
    content: str = "# Note\n",
) -> dict:
    response = await client.post(
        "/api/notes", json={"path": path, "content": content}, headers=headers
    )
    assert response.status_code == 201, response.text
    return response.json()


async def _export(client: AsyncClient) -> Any:
    response = await client.get("/api/export")
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/zip"
    return response


def _read_zip(response: Any) -> tuple[str, dict[str, bytes]]:
    """Return ``(root_name, {relative_path: bytes})`` for an export download."""
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        names = archive.namelist()
        roots = {name.split("/", 1)[0] for name in names}
        assert len(roots) == 1, roots
        root = roots.pop()
        files = {name[len(root) + 1 :]: archive.read(name) for name in names}
    return root, files


def _json(files: dict[str, bytes], name: str) -> dict:
    return json.loads(files[name].decode("utf-8"))


def _parse(instant: str) -> datetime:
    parsed = datetime.fromisoformat(instant.replace("Z", "+00:00"))
    assert parsed.tzinfo is not None
    return parsed


# --- the complete export --------------------------------------------------------


async def test_a_full_export_captures_notes_tasks_and_projects(
    notes_client: AsyncClient,
) -> None:
    headers = await _auth(notes_client)
    project = await _project(notes_client, headers, "Launch", target_date="2026-12-15")
    filed = await _task(
        notes_client,
        headers,
        "Filed",
        project_id=project["id"],
        priority="high",
        due_at="2026-11-02T17:00:00Z",
    )
    unfiled = await _task(notes_client, headers, "Unfiled")
    note = await _note(notes_client, headers, "Plans/Launch.md", _LINK_CONTENT)
    other = await _note(notes_client, headers, "Other.md", "# Other\n")
    assert (
        await notes_client.put(f"/api/projects/{project['id']}/notes/{note['id']}", headers=headers)
    ).status_code == 204

    response = await _export(notes_client)

    root, files = _read_zip(response)
    assert root.startswith("atlas-export-")
    assert response.headers["content-disposition"] == f'attachment; filename="{root}.zip"'

    # Every store is present, in open formats.
    assert set(files) >= {
        "manifest.json",
        "data.json",
        "notes.json",
        "notes/Plans/Launch.md",
        "notes/Other.md",
    }

    # data.json is the M4-07 document (reused) plus the additive unfiled_tasks.
    data = _json(files, "data.json")
    assert data["format"] == "atlas.project-export" and data["version"] == 1
    assert [entry["id"] for entry in data["projects"]] == [project["id"]]
    exported_project = data["projects"][0]
    assert [task["id"] for task in exported_project["tasks"]] == [filed["id"]]
    assert [task["id"] for task in data["unfiled_tasks"]] == [unfiled["id"]]
    assert exported_project["tasks"][0]["due_at"] == _parse(filed["due_at"]).isoformat().replace(
        "+00:00", "Z"
    )

    # notes.json is the metadata needed to reconstruct the links/tags (no content).
    index = _json(files, "notes.json")
    assert index["format"] == "atlas.notes-index" and index["version"] == 1
    by_id = {entry["id"]: entry for entry in index["notes"]}
    assert set(by_id) == {note["id"], other["id"]}
    launch = by_id[note["id"]]
    assert launch["path"] == "Plans/Launch.md"
    assert launch["tags"] == ["planning", "work"]
    assert launch["links"] == [{"target": "Other.md", "note_id": other["id"]}]
    assert launch["projects"] == [project["id"]]
    assert "content" not in launch

    # The manifest describes and verifies the set.
    manifest = _json(files, "manifest.json")
    assert manifest["format"] == "atlas.full-export" and manifest["format_version"] == 1
    assert manifest["contents"] == {
        "projects": 1,
        "tasks": 2,
        "notes": 2,
        "note_project_links": 1,
    }
    assert {record["path"] for record in manifest["files"]} == {
        "data.json",
        "notes.json",
        "notes/Plans/Launch.md",
        "notes/Other.md",
    }


async def test_the_exported_notes_are_the_real_markdown_bytes(
    notes_client: AsyncClient, notes_storage: NotesStorage
) -> None:
    headers = await _auth(notes_client)
    content = "# Héllo — Ünïcode ✅\n\nbody with tabs\tand unicode ☃\n"
    await _note(notes_client, headers, "Unicode.md", content)

    _root, files = _read_zip(await _export(notes_client))

    exported = files["notes/Unicode.md"]
    assert exported.decode("utf-8") == content
    # Byte-identical to the file on disk in the notes root.
    assert exported == (notes_storage.root / "Unicode.md").read_bytes()


async def test_the_export_reads_one_repeatable_read_snapshot(
    notes_client: AsyncClient, notes_storage: NotesStorage, tmp_path: Path
) -> None:
    await _auth(notes_client)
    user_id = uuid.UUID((await notes_client.get("/api/auth/me")).json()["id"])

    async with session_scope() as session:
        service = ExportService(session, user_id, notes_storage)
        await service.build_set(tmp_path / "snapshot-set")
        isolation = await session.scalar(text("SHOW transaction_isolation"))

    assert isolation == "repeatable read"


async def test_the_export_matches_the_m4_07_project_document(
    notes_client: AsyncClient,
) -> None:
    headers = await _auth(notes_client)
    project = await _project(notes_client, headers, "Launch", start_date="2026-11-01")
    await _task(notes_client, headers, "Task", project_id=project["id"])
    note = await _note(notes_client, headers, "Plans/Launch.md", _LINK_CONTENT)
    assert (
        await notes_client.put(f"/api/projects/{project['id']}/notes/{note['id']}", headers=headers)
    ).status_code == 204

    _root, files = _read_zip(await _export(notes_client))
    from_export = _json(files, "data.json")["projects"][0]
    from_endpoint = (await notes_client.get(f"/api/projects/{project['id']}/export")).json()[
        "projects"
    ][0]

    for field in ("id", "name", "status", "start_date", "target_date", "revision", "progress"):
        assert from_export[field] == from_endpoint[field], field
    assert [t["id"] for t in from_export["tasks"]] == [t["id"] for t in from_endpoint["tasks"]]
    assert [n["id"] for n in from_export["notes"]] == [n["id"] for n in from_endpoint["notes"]]


# --- the empty case -------------------------------------------------------------


async def test_an_empty_export_is_well_formed(notes_client: AsyncClient) -> None:
    await _auth(notes_client)

    _root, files = _read_zip(await _export(notes_client))

    data = _json(files, "data.json")
    assert data["projects"] == [] and data["unfiled_tasks"] == []
    assert _json(files, "notes.json")["notes"] == []
    assert not any(name.startswith("notes/") for name in files)
    manifest = _json(files, "manifest.json")
    assert manifest["contents"] == {
        "projects": 0,
        "tasks": 0,
        "notes": 0,
        "note_project_links": 0,
    }
    assert {record["path"] for record in manifest["files"]} == {"data.json", "notes.json"}


# --- an open, self-describing, verifiable set -----------------------------------


async def test_the_manifest_verifies_the_downloaded_set(
    notes_client: AsyncClient, tmp_path: Path
) -> None:
    headers = await _auth(notes_client)
    project = await _project(notes_client, headers, "Launch")
    await _task(notes_client, headers, "Filed", project_id=project["id"])
    await _task(notes_client, headers, "Unfiled")
    await _note(notes_client, headers, "Note.md", "# Note\n")

    _root, files = _read_zip(await _export(notes_client))

    # Re-assemble the downloaded bytes on disk and check them against the manifest.
    set_dir = tmp_path / "downloaded"
    for rel, data in files.items():
        target = set_dir / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    verification = verify_export_set(set_dir)
    assert verification.ok is True, verification.errors
    assert manifest_files(files) == {check.path for check in verification.files}


def manifest_files(files: dict[str, bytes]) -> set[str]:
    return {record["path"] for record in _json(files, "manifest.json")["files"]}


async def test_the_exported_instants_are_iso_8601_utc(notes_client: AsyncClient) -> None:
    headers = await _auth(notes_client)
    await _task(notes_client, headers, "Timed", due_at="2026-11-02T17:00:00Z")

    _root, files = _read_zip(await _export(notes_client))

    unfiled = _json(files, "data.json")["unfiled_tasks"][0]
    assert unfiled["due_at"].endswith("Z")
    assert unfiled["created_at"].endswith("Z")
    assert _parse(unfiled["due_at"]).tzinfo is not None


# --- completeness + scoping -----------------------------------------------------


async def test_soft_deleted_rows_are_excluded(notes_client: AsyncClient) -> None:
    headers = await _auth(notes_client)
    kept = await _project(notes_client, headers, "Kept")
    doomed = await _project(notes_client, headers, "Doomed")
    gone_note = await _note(notes_client, headers, "Gone.md", "# Gone\n")
    assert (
        await notes_client.delete(f"/api/projects/{doomed['id']}", headers=headers)
    ).status_code == 204
    assert (
        await notes_client.delete(f"/api/notes/{gone_note['id']}", headers=headers)
    ).status_code == 204

    _root, files = _read_zip(await _export(notes_client))

    assert [entry["id"] for entry in _json(files, "data.json")["projects"]] == [kept["id"]]
    assert _json(files, "notes.json")["notes"] == []
    assert "notes/Gone.md" not in files


async def _seed_foreign(notes_storage: NotesStorage) -> str:
    """Another user's project (with a task, a linked note and a real note file)."""
    notes_storage.write("Theirs.md", "# Theirs\n")
    async with session_scope() as session:
        other = User(
            id=uuid.uuid4(),
            email=f"{uuid.uuid4()}@example.com",
            display_name="Other",
            password_hash="not-used",
        )
        session.add(other)
        await session.flush()
        project = Project(
            id=uuid.uuid4(), user_id=other.id, name="Theirs", status=ProjectStatus.ACTIVE.value
        )
        note = NoteIndex(
            id=uuid.uuid4(),
            user_id=other.id,
            path="Theirs.md",
            title="Theirs",
            content_hash="0" * 64,
            revision=1,
            size_bytes=0,
        )
        session.add_all([project, note])
        await session.flush()
        session.add(Task(user_id=other.id, title="Their task", project_id=project.id))
        session.add(Task(user_id=other.id, title="Their unfiled task"))
        session.add(NoteProject(note_id=note.id, project_id=project.id))
        await session.flush()
        return str(project.id)


async def test_the_export_is_strictly_user_scoped(
    notes_client: AsyncClient, notes_storage: NotesStorage
) -> None:
    headers = await _auth(notes_client)
    mine = await _project(notes_client, headers, "Mine")
    my_note = await _note(notes_client, headers, "Mine.md", "# Mine\n")
    foreign_project_id = await _seed_foreign(notes_storage)

    _root, files = _read_zip(await _export(notes_client))

    data = _json(files, "data.json")
    assert [entry["id"] for entry in data["projects"]] == [mine["id"]]
    assert foreign_project_id not in json.dumps(data)
    assert [entry["id"] for entry in _json(files, "notes.json")["notes"]] == [my_note["id"]]
    # The foreign note file is never swept in just because it sits in the same notes root.
    assert "notes/Theirs.md" not in files


async def test_the_export_requires_authentication(notes_client: AsyncClient) -> None:
    assert (await notes_client.get("/api/export")).status_code == 401


# --- the operator CLI -----------------------------------------------------------


async def test_the_cli_exports_and_verifies_a_set(
    notes_client: AsyncClient,
    notes_storage: NotesStorage,
    tmp_path: Path,
    monkeypatch: Any,
) -> None:
    headers = await _auth(notes_client)
    project = await _project(notes_client, headers, "Launch")
    await _task(notes_client, headers, "Filed", project_id=project["id"])
    await _task(notes_client, headers, "Unfiled")
    await _note(notes_client, headers, "Note.md", "# Note\n")

    destination = tmp_path / "exports"
    settings = SimpleNamespace(notes_root=str(notes_storage.root), export_dir=str(destination))
    monkeypatch.setattr(export_cli, "get_settings", lambda: settings)

    code = await export_cli._export("owner@example.com", None, destination)
    assert code == 0

    published = [
        p for p in destination.iterdir() if p.is_dir() and p.name.startswith("atlas-export-")
    ]
    assert len(published) == 1
    verification = verify_export_set(published[0])
    assert verification.ok is True, verification.errors
    assert export_cli.main(["list", str(destination)]) == 0
    assert export_cli.main(["verify", str(destination)]) == 0
