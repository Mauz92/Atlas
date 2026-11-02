"""Daily note and templates (MU-07, ADR-0049) against a real PostgreSQL over HTTP.

The daily note is a normal Markdown file created on demand: creating it twice or concurrently
yields one file and never rewrites an existing one. Templates are untrusted notes in `templates/`
with two substituted placeholders.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import TYPE_CHECKING

import pytest
from sqlalchemy import func, select

from atlas.db import session_scope
from atlas.models import NoteIndex, User
from tests.conftest import create_user_via_setup, csrf_headers

if TYPE_CHECKING:
    from httpx import AsyncClient

    from atlas.notes import NotesStorage

DAY = "2026-11-02"


async def _auth(client: AsyncClient) -> dict[str, str]:
    await create_user_via_setup(client)
    return csrf_headers(client)


async def _note(client: AsyncClient, headers: dict[str, str], path: str, content: str) -> dict:
    response = await client.post(
        "/api/notes", json={"path": path, "content": content}, headers=headers
    )
    assert response.status_code == 201, response.text
    return response.json()


async def _daily(client: AsyncClient, headers: dict[str, str], day: str = DAY):
    return await client.post("/api/notes/daily", json={"date": day}, headers=headers)


async def test_requires_authentication(notes_client: AsyncClient) -> None:
    assert (await notes_client.post("/api/notes/daily", json={"date": DAY})).status_code in (
        401,
        403,
    )
    body = {"path": "x", "template_id": str(uuid.uuid4())}
    assert (await notes_client.post("/api/notes/from-template", json=body)).status_code in (
        401,
        403,
    )


async def test_daily_note_is_created_once_and_never_rewritten(
    notes_client: AsyncClient, notes_storage: NotesStorage
) -> None:
    headers = await _auth(notes_client)
    first = await _daily(notes_client, headers)
    assert first.status_code == 201, first.text
    note = first.json()
    assert note["path"] == f"daily/{DAY}.md"
    assert (notes_storage.root / "daily" / f"{DAY}.md").read_text(encoding="utf-8") == f"# {DAY}\n"

    edited = await notes_client.put(
        f"/api/notes/{note['id']}",
        json={"content": "# Mine\n\nwritten today\n", "base_revision": note["revision"]},
        headers=headers,
    )
    assert edited.status_code == 200
    again = await _daily(notes_client, headers)
    assert again.status_code == 200
    assert again.json()["id"] == note["id"]
    assert again.json()["content"] == "# Mine\n\nwritten today\n"
    assert again.json()["revision"] == edited.json()["revision"]


async def test_concurrent_requests_create_exactly_one_note(
    notes_client: AsyncClient, notes_storage: NotesStorage
) -> None:
    headers = await _auth(notes_client)
    responses = await asyncio.gather(*(_daily(notes_client, headers) for _ in range(6)))
    assert sorted(r.status_code for r in responses) == [200] * 5 + [201]
    assert len({r.json()["id"] for r in responses}) == 1
    async with session_scope() as session:
        rows = await session.scalar(select(func.count()).select_from(NoteIndex))
    assert rows == 1
    assert [p.name for p in (notes_storage.root / "daily").iterdir()] == [f"{DAY}.md"]


async def test_a_file_added_outside_atlas_is_adopted_not_replaced(
    notes_client: AsyncClient, notes_storage: NotesStorage
) -> None:
    headers = await _auth(notes_client)
    notes_storage.write(f"daily/{DAY}.md", "# From my editor\n")
    response = await _daily(notes_client, headers)
    assert response.status_code == 200
    assert response.json()["content"] == "# From my editor\n"
    assert response.json()["title"] == "From my editor"


@pytest.mark.parametrize(
    "day",
    [
        "2026-13-01",
        "2026-02-30",
        "2026-1-1",
        "2026-11-02/../../x",
        "\uff12\uff10\uff12\uff16-11-02",
        "today",
    ],
)
async def test_invalid_days_are_rejected_with_the_message(
    notes_client: AsyncClient, notes_storage: NotesStorage, day: str
) -> None:
    headers = await _auth(notes_client)
    response = await _daily(notes_client, headers, day)
    assert response.status_code == 400
    assert response.json()["detail"] == "date must be a calendar day written YYYY-MM-DD"
    assert not (notes_storage.root / "daily").exists()


async def test_another_users_note_does_not_count_as_mine(notes_client: AsyncClient) -> None:
    headers = await _auth(notes_client)
    async with session_scope() as session:
        other = User(
            id=uuid.uuid4(), email="o@example.com", display_name="O", password_hash="not-used"
        )
        session.add(other)
        await session.flush()
        session.add(
            NoteIndex(
                user_id=other.id,
                path=f"daily/{DAY}.md",
                title="Theirs",
                content_hash="0" * 64,
                revision=1,
                size_bytes=0,
            )
        )
    assert (await _daily(notes_client, headers)).status_code == 201


async def test_daily_note_uses_the_daily_template_when_present(notes_client: AsyncClient) -> None:
    headers = await _auth(notes_client)
    await _note(notes_client, headers, "templates/daily", "# {{date}}\n\n## Plan\n")
    response = await _daily(notes_client, headers)
    assert response.json()["content"] == f"# {DAY}\n\n## Plan\n"


@pytest.mark.parametrize(
    ("template", "path", "expected"),
    [
        ("# {{title}} on {{date}}\n", "Projects/Alpha", f"# Alpha on {DAY}\n"),
        ("{{ date }}|{{  title}}", "Alpha", f"{DAY}|Alpha"),
        # Only the two placeholders are known; everything else is copied as plain text.
        ("{{time}} {{__import__('os')}} {{{{date}}}} <script>x</script>", "A", None),
        # Substituted values are not expanded again.
        ("{{title}}", "{{date}}", "{{date}}"),
    ],
)
async def test_template_substitution(
    notes_client: AsyncClient, template: str, path: str, expected: str | None
) -> None:
    headers = await _auth(notes_client)
    source = await _note(notes_client, headers, "templates/t", template)
    response = await notes_client.post(
        "/api/notes/from-template",
        json={"path": path, "template_id": source["id"], "date": DAY},
        headers=headers,
    )
    assert response.status_code == 201, response.text
    content = response.json()["content"]
    assert content == (
        expected if expected is not None else template.replace("{{{{date}}}}", "{{" + DAY + "}}")
    )


@pytest.mark.parametrize("case", ["not-a-template", "unknown", "exists", "traversal", "bad-date"])
async def test_template_failures_change_nothing(
    notes_client: AsyncClient, notes_storage: NotesStorage, case: str
) -> None:
    headers = await _auth(notes_client)
    template = await _note(notes_client, headers, "templates/t", "# T\n")
    existing = await _note(notes_client, headers, "Existing", "keep me\n")
    other = await _note(notes_client, headers, "Other", "# not a template\n")
    body = {"path": "New", "template_id": template["id"]}
    expected = {
        "not-a-template": (400, "a template must be a note in the templates/ folder"),
        "unknown": (404, "Not found"),
        "exists": (409, "A note or folder already exists there"),
        "traversal": (400, "path traversal is not allowed"),
        "bad-date": (400, "date must be a calendar day written YYYY-MM-DD"),
    }[case]
    if case == "not-a-template":
        body["template_id"] = other["id"]
    elif case == "unknown":
        body["template_id"] = str(uuid.uuid4())
    elif case == "exists":
        body["path"] = existing["path"]
    elif case == "traversal":
        body["path"] = "../escape"
    else:
        body["date"] = "yesterday"
    response = await notes_client.post("/api/notes/from-template", json=body, headers=headers)
    assert (response.status_code, response.json()["detail"]) == expected
    assert not (notes_storage.root / "New.md").exists()
    assert not notes_storage.root.parent.joinpath("escape.md").exists()
    assert (notes_storage.root / "Existing.md").read_text(encoding="utf-8") == "keep me\n"


async def test_write_new_never_replaces_and_leaves_no_temp_files(
    notes_storage: NotesStorage,
) -> None:
    notes_storage.write_new("a/b.md", "first")
    with pytest.raises(FileExistsError):
        notes_storage.write_new("a/b.md", "second")
    assert notes_storage.read("a/b.md").content == "first"
    assert [p.name for p in (notes_storage.root / "a").iterdir()] == ["b.md"]
