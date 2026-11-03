from httpx import AsyncClient

from atlas.notes import NotesStorage
from tests.conftest import create_user_via_setup, csrf_headers


async def _auth(client: AsyncClient) -> dict[str, str]:
    await create_user_via_setup(client)
    return csrf_headers(client)


def _note_by_path(body: dict, path: str) -> dict:
    for note in body["notes"]:
        if note["path"] == path:
            return note
    raise AssertionError(f"{path} not in {body['notes']}")


async def test_notes_require_authentication(client: AsyncClient) -> None:
    assert (await client.get("/api/notes")).status_code == 401


async def test_create_note_writes_a_real_markdown_file(
    notes_client: AsyncClient, notes_storage: NotesStorage
) -> None:
    headers = await _auth(notes_client)
    response = await notes_client.post(
        "/api/notes",
        json={"path": "Inbox/First", "content": "# Hello\n\nBody.\n"},
        headers=headers,
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["path"] == "Inbox/First.md"
    assert body["revision"] == 1
    assert body["title"] == "Hello"

    on_disk = notes_storage.root / "Inbox" / "First.md"
    assert on_disk.read_text(encoding="utf-8") == "# Hello\n\nBody.\n"


async def test_get_returns_content_and_metadata(notes_client: AsyncClient) -> None:
    headers = await _auth(notes_client)
    created = await notes_client.post(
        "/api/notes", json={"path": "A.md", "content": "# A\n"}, headers=headers
    )
    note_id = created.json()["id"]

    fetched = await notes_client.get(f"/api/notes/{note_id}")
    assert fetched.status_code == 200
    assert fetched.json()["content"] == "# A\n"
    assert fetched.json()["content_hash"] == created.json()["content_hash"]


async def test_list_notes_and_folders(notes_client: AsyncClient) -> None:
    headers = await _auth(notes_client)
    for path in ("Inbox/One.md", "Inbox/Two.md", "Root.md"):
        await notes_client.post("/api/notes", json={"path": path, "content": "x"}, headers=headers)

    listing = await notes_client.get("/api/notes")
    assert listing.status_code == 200
    body = listing.json()
    assert [note["path"] for note in body["notes"]] == ["Inbox/One.md", "Inbox/Two.md", "Root.md"]
    assert "Inbox" in body["folders"]

    only_inbox = await notes_client.get("/api/notes", params={"folder": "Inbox"})
    assert [note["path"] for note in only_inbox.json()["notes"]] == [
        "Inbox/One.md",
        "Inbox/Two.md",
    ]


async def test_update_requires_the_current_revision(notes_client: AsyncClient) -> None:
    headers = await _auth(notes_client)
    created = (
        await notes_client.post(
            "/api/notes", json={"path": "A.md", "content": "# v1\n"}, headers=headers
        )
    ).json()

    updated = await notes_client.put(
        f"/api/notes/{created['id']}",
        json={"content": "# v2\n", "base_revision": created["revision"]},
        headers=headers,
    )
    assert updated.status_code == 200
    assert updated.json()["revision"] == created["revision"] + 1
    assert updated.json()["content"] == "# v2\n"

    stale = await notes_client.put(
        f"/api/notes/{created['id']}",
        json={"content": "# v3\n", "base_revision": created["revision"]},
        headers=headers,
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["current_revision"] == created["revision"] + 1

    unchanged = await notes_client.get(f"/api/notes/{created['id']}")
    assert unchanged.json()["content"] == "# v2\n"


async def test_external_edit_is_never_overwritten(
    notes_client: AsyncClient, notes_storage: NotesStorage
) -> None:
    headers = await _auth(notes_client)
    created = (
        await notes_client.post(
            "/api/notes", json={"path": "A.md", "content": "# from api\n"}, headers=headers
        )
    ).json()

    (notes_storage.root / "A.md").write_text("# edited externally\n", encoding="utf-8")

    response = await notes_client.put(
        f"/api/notes/{created['id']}",
        json={"content": "# from api again\n", "base_revision": created["revision"]},
        headers=headers,
    )
    assert response.status_code == 409
    assert (notes_storage.root / "A.md").read_text(encoding="utf-8") == "# edited externally\n"


async def test_conflict_copy_preserves_both_versions(
    notes_client: AsyncClient, notes_storage: NotesStorage
) -> None:
    headers = await _auth(notes_client)
    created = (
        await notes_client.post(
            "/api/notes", json={"path": "A.md", "content": "# original\n"}, headers=headers
        )
    ).json()

    response = await notes_client.post(
        f"/api/notes/{created['id']}/conflict",
        json={"content": "# conflicting edit\n"},
        headers=headers,
    )
    assert response.status_code == 201
    copy_path = response.json()["path"]
    assert "conflict" in copy_path

    files = sorted(p.name for p in notes_storage.root.glob("*.md"))
    assert set(files) == {"A.md", copy_path}
    assert (notes_storage.root / "A.md").read_text(encoding="utf-8") == "# original\n"


async def test_delete_moves_the_note_to_trash(
    notes_client: AsyncClient, notes_storage: NotesStorage
) -> None:
    headers = await _auth(notes_client)
    created = (
        await notes_client.post(
            "/api/notes", json={"path": "Doomed.md", "content": "bye"}, headers=headers
        )
    ).json()

    assert (
        await notes_client.delete(f"/api/notes/{created['id']}", headers=headers)
    ).status_code == 204
    assert not (notes_storage.root / "Doomed.md").exists()
    assert (await notes_client.get(f"/api/notes/{created['id']}")).status_code == 404

    listing = await notes_client.get("/api/notes")
    assert listing.json()["notes"] == []


async def test_search_finds_notes_by_content_and_title(notes_client: AsyncClient) -> None:
    headers = await _auth(notes_client)
    await notes_client.post(
        "/api/notes",
        json={"path": "Alpha.md", "content": "# Alpha\n\nThe quick brown fox.\n"},
        headers=headers,
    )
    await notes_client.post(
        "/api/notes",
        json={"path": "Beta.md", "content": "# Beta\n\nSomething else.\n"},
        headers=headers,
    )

    results = await notes_client.get("/api/notes/search", params={"q": "brown fox"})
    assert [note["path"] for note in results.json()] == ["Alpha.md"]

    by_title = await notes_client.get("/api/notes/search", params={"q": "beta"})
    assert [note["path"] for note in by_title.json()] == ["Beta.md"]


async def test_wiki_links_resolve_and_report_unresolved(notes_client: AsyncClient) -> None:
    headers = await _auth(notes_client)
    await notes_client.post(
        "/api/notes", json={"path": "Target.md", "content": "# Target\n"}, headers=headers
    )
    source = (
        await notes_client.post(
            "/api/notes",
            json={"path": "Source.md", "content": "See [[Target]] and [[Missing]].\n"},
            headers=headers,
        )
    ).json()

    targets = {link["target_path"]: link["target_note_id"] for link in source["links"]}
    assert targets["Target.md"] is not None
    assert targets["Missing.md"] is None
    assert source["unresolved_links"] == ["Missing.md"]


async def test_creating_a_target_resolves_earlier_unresolved_links(
    notes_client: AsyncClient,
) -> None:
    headers = await _auth(notes_client)
    source = (
        await notes_client.post(
            "/api/notes", json={"path": "Source.md", "content": "See [[Later]].\n"}, headers=headers
        )
    ).json()
    assert source["unresolved_links"] == ["Later.md"]

    await notes_client.post(
        "/api/notes", json={"path": "Later.md", "content": "# Later\n"}, headers=headers
    )

    refreshed = await notes_client.get(f"/api/notes/{source['id']}")
    assert refreshed.json()["unresolved_links"] == []
    assert refreshed.json()["links"][0]["target_note_id"] is not None


async def test_backlinks_and_rename_preserve_links(notes_client: AsyncClient) -> None:
    headers = await _auth(notes_client)
    target = (
        await notes_client.post(
            "/api/notes", json={"path": "Target.md", "content": "# T\n"}, headers=headers
        )
    ).json()
    await notes_client.post(
        "/api/notes", json={"path": "Source.md", "content": "[[Target]]\n"}, headers=headers
    )

    assert [
        n["path"]
        for n in (await notes_client.get(f"/api/notes/{target['id']}")).json()["backlinks"]
    ] == ["Source.md"]

    renamed = await notes_client.post(
        f"/api/notes/{target['id']}/move", json={"path": "Renamed.md"}, headers=headers
    )
    assert renamed.status_code == 200
    assert renamed.json()["id"] == target["id"]
    assert renamed.json()["path"] == "Renamed.md"

    source = _note_by_path((await notes_client.get("/api/notes")).json(), "Source.md")
    detail = (await notes_client.get(f"/api/notes/{source['id']}")).json()
    assert detail["links"][0]["target_path"] == "Renamed.md"
    assert detail["links"][0]["target_note_id"] == target["id"]


async def test_folder_rename_moves_notes_and_keeps_identity(notes_client: AsyncClient) -> None:
    headers = await _auth(notes_client)
    note = (
        await notes_client.post(
            "/api/notes", json={"path": "Old/Note.md", "content": "# N\n"}, headers=headers
        )
    ).json()

    await notes_client.post("/api/folders", json={"path": "Unused"}, headers=headers)
    response = await notes_client.post(
        "/api/folders/rename", json={"path": "Old", "new_path": "New"}, headers=headers
    )
    assert response.status_code == 200
    assert response.json()["moved_notes"] == 1

    listing = (await notes_client.get("/api/notes")).json()
    assert [n["path"] for n in listing["notes"]] == ["New/Note.md"]
    assert listing["notes"][0]["id"] == note["id"]


async def test_folder_deletion_requires_an_empty_folder(notes_client: AsyncClient) -> None:
    headers = await _auth(notes_client)
    await notes_client.post(
        "/api/notes", json={"path": "Full/Note.md", "content": "x"}, headers=headers
    )

    busy = await notes_client.delete("/api/folders", params={"path": "Full"}, headers=headers)
    assert busy.status_code == 409

    await notes_client.post("/api/folders", json={"path": "Empty"}, headers=headers)
    empty = await notes_client.delete("/api/folders", params={"path": "Empty"}, headers=headers)
    assert empty.status_code == 204


async def test_path_traversal_is_rejected(notes_client: AsyncClient) -> None:
    headers = await _auth(notes_client)
    for path in ("../escape.md", "/etc/passwd", ".atlas/trash/x.md"):
        response = await notes_client.post(
            "/api/notes", json={"path": path, "content": "x"}, headers=headers
        )
        assert response.status_code == 400, path


async def test_unicode_content_round_trips_through_the_api(notes_client: AsyncClient) -> None:
    headers = await _auth(notes_client)
    content = "# Ünïcödé 🎉\n\n日本語 and Кириллица and em—dash.\n"
    created = (
        await notes_client.post(
            "/api/notes", json={"path": "Uni.md", "content": content}, headers=headers
        )
    ).json()
    assert created["content"] == content
    assert (await notes_client.get(f"/api/notes/{created['id']}")).json()["content"] == content


async def test_tags_are_indexed_and_returned(notes_client: AsyncClient) -> None:
    headers = await _auth(notes_client)
    created = (
        await notes_client.post(
            "/api/notes",
            json={"path": "Tagged.md", "content": "---\ntags: [alpha]\n---\n\n#beta and #gamma\n"},
            headers=headers,
        )
    ).json()
    assert created["tags"] == ["alpha", "beta", "gamma"]


async def test_crlf_note_round_trips_and_autosave_does_not_conflict(
    notes_client: AsyncClient, notes_storage: NotesStorage
) -> None:
    """R-24: a CRLF note is served with its CRLF, so the next save is not a false conflict."""
    headers = await _auth(notes_client)
    text = "# Win\r\n\r\nLine one\r\n"
    created = await notes_client.post(
        "/api/notes", json={"path": "Win.md", "content": text}, headers=headers
    )
    assert created.status_code == 201, created.text
    note = created.json()

    fetched = (await notes_client.get(f"/api/notes/{note['id']}")).json()
    assert fetched["content"] == text

    edited = text + "Line two\r\n"
    saved = await notes_client.put(
        f"/api/notes/{note['id']}",
        json={"content": edited, "base_revision": fetched["revision"]},
        headers=headers,
    )
    assert saved.status_code == 200, saved.text
    assert (notes_storage.root / "Win.md").read_bytes() == edited.encode("utf-8")


async def test_a_maximum_size_note_of_escaped_characters_round_trips(
    notes_client: AsyncClient,
) -> None:
    """5 MiB of newlines is a ~10 MiB JSON body: the API accepts what nginx lets through (R-34)."""
    from atlas.notes.storage import MAX_NOTE_BYTES

    await create_user_via_setup(notes_client)
    headers = csrf_headers(notes_client)
    content = "\n" * MAX_NOTE_BYTES
    created = await notes_client.post(
        "/api/notes", json={"path": "Big.md", "content": content}, headers=headers
    )
    assert created.status_code == 201, created.text[:200]
    fetched = await notes_client.get(f"/api/notes/{created.json()['id']}")
    assert fetched.json()["content"] == content
    too_big = await notes_client.post(
        "/api/notes", json={"path": "Bigger.md", "content": content + "x"}, headers=headers
    )
    assert too_big.status_code in (413, 422)  # refused by the API, not stored
