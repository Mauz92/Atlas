"""Note↔project association (M4-05) against a real PostgreSQL over HTTP.

Covers the M4-05 acceptance criteria: a note can be linked to and unlinked from a project; both
directions are listable; linking is idempotent; **the link survives a note rename** (it references
the note's stable id, not its path); a note delete / project delete removes the link without
deleting anything else; and unknown, another user's or tombstoned targets are rejected with no side
effects. Everything is strictly user-scoped.

Requires a database (``notes_client`` pulls in ``_db``).
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import func, select

from atlas.db import session_scope
from atlas.models import NoteIndex, NoteProject, Project, User
from tests.conftest import create_user_via_setup, csrf_headers

if TYPE_CHECKING:
    from httpx import AsyncClient


async def _auth(client: AsyncClient) -> dict[str, str]:
    await create_user_via_setup(client)
    return csrf_headers(client)


async def _note(
    client: AsyncClient, headers: dict[str, str], path: str = "Note.md", content: str = "# Note\n"
) -> dict:
    response = await client.post(
        "/api/notes", json={"path": path, "content": content}, headers=headers
    )
    assert response.status_code == 201, response.text
    return response.json()


async def _project(client: AsyncClient, headers: dict[str, str], name: str = "Project") -> dict:
    response = await client.post("/api/projects", json={"name": name}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


async def _link(client: AsyncClient, headers: dict[str, str], project_id: str, note_id: str):
    return await client.put(f"/api/projects/{project_id}/notes/{note_id}", headers=headers)


async def _unlink(client: AsyncClient, headers: dict[str, str], project_id: str, note_id: str):
    return await client.delete(f"/api/projects/{project_id}/notes/{note_id}", headers=headers)


async def _project_notes(client: AsyncClient, project_id: str) -> list[dict]:
    """The notes the project endpoint reports, asserting it answered ``200``."""
    response = await client.get(f"/api/projects/{project_id}/notes")
    assert response.status_code == 200, response.text
    return response.json()["notes"]


async def _note_projects(client: AsyncClient, note_id: str) -> list[dict]:
    """The projects the note endpoint reports, asserting it answered ``200``."""
    response = await client.get(f"/api/notes/{note_id}/projects")
    assert response.status_code == 200, response.text
    return response.json()["projects"]


async def _link_count(*, note_id: str | None = None, project_id: str | None = None) -> int:
    """Count ``note_projects`` rows directly (proves what is actually stored)."""
    async with session_scope() as session:
        stmt = select(func.count()).select_from(NoteProject)
        if note_id is not None:
            stmt = stmt.where(NoteProject.note_id == uuid.UUID(note_id))
        if project_id is not None:
            stmt = stmt.where(NoteProject.project_id == uuid.UUID(project_id))
        return int(await session.scalar(stmt) or 0)


async def _seed_foreign() -> tuple[str, str]:
    """Another user's project and note; returns ``(project_id, note_id)``.

    The API is never used: the second account exists only to prove its data is invisible to the
    authenticated caller.
    """
    async with session_scope() as session:
        other = User(
            id=uuid.uuid4(),
            email=f"{uuid.uuid4()}@example.com",
            display_name="Other",
            password_hash="not-used",
        )
        session.add(other)
        await session.flush()
        project = Project(id=uuid.uuid4(), user_id=other.id, name="Theirs")
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
        return str(project.id), str(note.id)


# --- linking, unlinking and listing --------------------------------------------


async def test_a_note_can_be_linked_to_a_project_and_listed_both_ways(
    notes_client: AsyncClient,
) -> None:
    headers = await _auth(notes_client)
    project = await _project(notes_client, headers, "Launch")
    note = await _note(notes_client, headers, "Plans/Launch.md", "# Launch plan\n")

    linked = await _link(notes_client, headers, project["id"], note["id"])
    assert linked.status_code == 204, linked.text

    listed = await _project_notes(notes_client, project["id"])
    assert [n["id"] for n in listed] == [note["id"]]
    assert listed[0]["path"] == "Plans/Launch.md"
    assert listed[0]["title"] == "Launch plan"

    back = await _note_projects(notes_client, note["id"])
    assert [p["id"] for p in back] == [project["id"]]
    assert back[0]["name"] == "Launch"
    assert "progress" in back[0]  # the project shape carries its derived progress (M4-04)
    assert await _link_count(note_id=note["id"]) == 1


async def test_linking_the_same_note_twice_is_idempotent(notes_client: AsyncClient) -> None:
    headers = await _auth(notes_client)
    project = await _project(notes_client, headers, "Launch")
    note = await _note(notes_client, headers)

    first = await _link(notes_client, headers, project["id"], note["id"])
    second = await _link(notes_client, headers, project["id"], note["id"])

    assert first.status_code == 204 and second.status_code == 204
    assert await _link_count(note_id=note["id"]) == 1
    assert [n["id"] for n in await _project_notes(notes_client, project["id"])] == [note["id"]]


async def test_unlinking_removes_the_association_and_is_idempotent(
    notes_client: AsyncClient,
) -> None:
    headers = await _auth(notes_client)
    project = await _project(notes_client, headers, "Launch")
    note = await _note(notes_client, headers)
    await _link(notes_client, headers, project["id"], note["id"])

    assert (await _unlink(notes_client, headers, project["id"], note["id"])).status_code == 204
    # Unlinking a link that is already gone is a no-op, not an error.
    assert (await _unlink(notes_client, headers, project["id"], note["id"])).status_code == 204

    assert await _project_notes(notes_client, project["id"]) == []
    assert await _note_projects(notes_client, note["id"]) == []
    assert await _link_count(note_id=note["id"]) == 0


async def test_a_note_can_be_linked_to_several_projects(notes_client: AsyncClient) -> None:
    headers = await _auth(notes_client)
    alpha = await _project(notes_client, headers, "Alpha")
    beta = await _project(notes_client, headers, "Beta")
    note = await _note(notes_client, headers)

    await _link(notes_client, headers, alpha["id"], note["id"])
    await _link(notes_client, headers, beta["id"], note["id"])

    assert {p["id"] for p in await _note_projects(notes_client, note["id"])} == {
        alpha["id"],
        beta["id"],
    }


async def test_a_project_can_list_several_notes_in_path_order(notes_client: AsyncClient) -> None:
    headers = await _auth(notes_client)
    project = await _project(notes_client, headers, "Launch")
    later = await _note(notes_client, headers, "B.md")
    earlier = await _note(notes_client, headers, "A.md")

    await _link(notes_client, headers, project["id"], later["id"])
    await _link(notes_client, headers, project["id"], earlier["id"])

    assert [n["path"] for n in await _project_notes(notes_client, project["id"])] == [
        "A.md",
        "B.md",
    ]


# --- rename survival -----------------------------------------------------------


async def test_the_link_survives_a_note_rename(notes_client: AsyncClient) -> None:
    """The association references the note's stable id, not its path (MARKDOWN_STORAGE.md)."""
    headers = await _auth(notes_client)
    project = await _project(notes_client, headers, "Launch")
    note = await _note(notes_client, headers, "Old/Name.md", "# Rename me\n")
    await _link(notes_client, headers, project["id"], note["id"])

    renamed = await notes_client.post(
        f"/api/notes/{note['id']}/move", json={"path": "New/Location.md"}, headers=headers
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["id"] == note["id"]  # same note, new path

    listed = await _project_notes(notes_client, project["id"])
    assert [n["id"] for n in listed] == [note["id"]]
    assert listed[0]["path"] == "New/Location.md"

    # The note side still resolves the project, and exactly one association row exists.
    assert [p["id"] for p in await _note_projects(notes_client, note["id"])] == [project["id"]]
    assert await _link_count(note_id=note["id"]) == 1


# --- deletion effects ----------------------------------------------------------


async def test_deleting_a_note_removes_its_links(notes_client: AsyncClient) -> None:
    headers = await _auth(notes_client)
    project = await _project(notes_client, headers, "Launch")
    note = await _note(notes_client, headers)
    await _link(notes_client, headers, project["id"], note["id"])

    assert (
        await notes_client.delete(f"/api/notes/{note['id']}", headers=headers)
    ).status_code == 204

    assert await _link_count(note_id=note["id"]) == 0
    assert await _project_notes(notes_client, project["id"]) == []
    # The note itself is tombstoned, so it is no longer addressable.
    assert (await notes_client.get(f"/api/notes/{note['id']}")).status_code == 404


async def test_deleting_a_project_removes_its_links_but_keeps_the_notes(
    notes_client: AsyncClient,
) -> None:
    headers = await _auth(notes_client)
    project = await _project(notes_client, headers, "Doomed")
    note = await _note(notes_client, headers, "Kept.md", "# Kept\n")
    await _link(notes_client, headers, project["id"], note["id"])

    assert (
        await notes_client.delete(f"/api/projects/{project['id']}", headers=headers)
    ).status_code == 204

    assert await _link_count(project_id=project["id"]) == 0
    # No note is deleted: it still exists and is readable.
    still_there = await notes_client.get(f"/api/notes/{note['id']}")
    assert still_there.status_code == 200
    assert still_there.json()["path"] == "Kept.md"
    # The tombstoned project is gone from the API and the link is dropped from the note's side.
    assert (await notes_client.get(f"/api/projects/{project['id']}/notes")).status_code == 404
    assert await _note_projects(notes_client, note["id"]) == []


# --- validation and user scoping -----------------------------------------------


async def test_unknown_and_foreign_targets_are_rejected_without_side_effects(
    notes_client: AsyncClient,
) -> None:
    headers = await _auth(notes_client)
    project = await _project(notes_client, headers, "Mine")
    note = await _note(notes_client, headers)
    foreign_project_id, foreign_note_id = await _seed_foreign()
    unknown = str(uuid.uuid4())

    responses = [
        await _link(notes_client, headers, unknown, note["id"]),  # unknown project
        await _link(notes_client, headers, project["id"], unknown),  # unknown note
        await _link(
            notes_client, headers, foreign_project_id, note["id"]
        ),  # another user's project
        await _link(notes_client, headers, project["id"], foreign_note_id),  # another user's note
    ]

    assert [r.status_code for r in responses] == [404, 404, 404, 404], [r.text for r in responses]
    # No association was written, and the caller's lists are unchanged (still empty).
    assert await _link_count() == 0
    assert await _project_notes(notes_client, project["id"]) == []
    assert await _note_projects(notes_client, note["id"]) == []


async def test_unlinking_with_unknown_or_foreign_targets_is_rejected(
    notes_client: AsyncClient,
) -> None:
    headers = await _auth(notes_client)
    project = await _project(notes_client, headers, "Mine")
    note = await _note(notes_client, headers)
    foreign_project_id, foreign_note_id = await _seed_foreign()

    assert (await _unlink(notes_client, headers, str(uuid.uuid4()), note["id"])).status_code == 404
    assert (
        await _unlink(notes_client, headers, project["id"], str(uuid.uuid4()))
    ).status_code == 404
    assert (await _unlink(notes_client, headers, foreign_project_id, note["id"])).status_code == 404
    assert (await _unlink(notes_client, headers, project["id"], foreign_note_id)).status_code == 404


async def test_a_tombstoned_project_cannot_be_linked_or_listed(notes_client: AsyncClient) -> None:
    headers = await _auth(notes_client)
    project = await _project(notes_client, headers, "Doomed")
    note = await _note(notes_client, headers)
    await _link(notes_client, headers, project["id"], note["id"])
    await notes_client.delete(f"/api/projects/{project['id']}", headers=headers)

    assert (await _link(notes_client, headers, project["id"], note["id"])).status_code == 404
    assert (await _unlink(notes_client, headers, project["id"], note["id"])).status_code == 404
    assert (await notes_client.get(f"/api/projects/{project['id']}/notes")).status_code == 404
    assert await _link_count() == 0


async def test_a_tombstoned_note_cannot_be_linked_or_listed(notes_client: AsyncClient) -> None:
    headers = await _auth(notes_client)
    project = await _project(notes_client, headers, "Mine")
    note = await _note(notes_client, headers)
    await _link(notes_client, headers, project["id"], note["id"])
    await notes_client.delete(f"/api/notes/{note['id']}", headers=headers)

    assert (await _link(notes_client, headers, project["id"], note["id"])).status_code == 404
    assert (await notes_client.get(f"/api/notes/{note['id']}/projects")).status_code == 404
    assert await _project_notes(notes_client, project["id"]) == []
    assert await _link_count() == 0


async def test_the_endpoints_are_strictly_user_scoped(notes_client: AsyncClient) -> None:
    headers = await _auth(notes_client)
    project = await _project(notes_client, headers, "Mine")
    note = await _note(notes_client, headers)
    await _link(notes_client, headers, project["id"], note["id"])
    foreign_project_id, foreign_note_id = await _seed_foreign()

    # Another user's objects are reported as missing on both listing endpoints.
    assert (await notes_client.get(f"/api/notes/{foreign_note_id}/projects")).status_code == 404
    assert (await notes_client.get(f"/api/projects/{foreign_project_id}/notes")).status_code == 404
    # The caller still sees only their own association.
    assert [n["id"] for n in await _project_notes(notes_client, project["id"])] == [note["id"]]
    assert [p["id"] for p in await _note_projects(notes_client, note["id"])] == [project["id"]]


async def test_the_endpoints_require_authentication(client: AsyncClient) -> None:
    project_id = uuid.uuid4()
    note_id = uuid.uuid4()
    assert (await client.get(f"/api/projects/{project_id}/notes")).status_code == 401
    assert (await client.put(f"/api/projects/{project_id}/notes/{note_id}")).status_code == 401
    assert (await client.delete(f"/api/projects/{project_id}/notes/{note_id}")).status_code == 401
    assert (await client.get(f"/api/notes/{note_id}/projects")).status_code == 401
