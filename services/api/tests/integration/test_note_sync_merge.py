"""Sync-mode note writes: history, three-way merge, conflict copies, edit-wins, revive, move and
replay (SYNC-04; ``SYNC_PROTOCOL.md`` 6.3). Bytes on disk are asserted exactly.
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from pathlib import Path
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import text

from atlas.db import session_scope
from atlas.notes import NotesStorage
from tests.conftest import create_user_via_setup, csrf_headers

pytestmark = pytest.mark.usefixtures("_db")


@pytest.fixture
async def c(notes_client: AsyncClient) -> AsyncClient:
    await create_user_via_setup(notes_client)
    return notes_client


def sha(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def h(c: AsyncClient, key: str | None = None) -> dict[str, str]:
    return {"Atlas-Sync": "1", "Idempotency-Key": key or str(uuid.uuid4()), **csrf_headers(c)}


async def create(c: AsyncClient, path: str, content: str, **extra: Any) -> dict[str, Any]:
    response = await c.post(
        "/api/notes", json={"path": path, "content": content, **extra}, headers=h(c)
    )
    assert response.status_code == 201, response.text
    return response.json()  # type: ignore[no-any-return]


async def put(c: AsyncClient, note: dict[str, Any], content: str, *, key: str | None = None) -> Any:
    """A sync-mode save based on ``note`` (a response dict: its revision and hash are the base)."""
    return await c.put(
        f"/api/notes/{note['id']}",
        json={
            "content": content,
            "base_revision": note["revision"],
            "base_hash": note["content_hash"],
        },
        headers=h(c, key),
    )


def disk(storage: NotesStorage, path: str) -> bytes:
    return (storage.root / path).read_bytes()


async def live_paths(c: AsyncClient) -> list[str]:
    return sorted(n["path"] for n in (await c.get("/api/notes")).json()["notes"])


BASE = "# Title\n\nalpha\n\nbeta\n\ngamma\n\ndelta\n"


# --- history ---------------------------------------------------------------------------------


async def test_every_revision_is_recorded_with_its_exact_bytes(
    c: AsyncClient, notes_storage: NotesStorage
) -> None:
    crlf = "one\r\ntwo\r\n"
    note = await create(c, "h.md", crlf)
    second = (await put(c, note, "one\r\ntwo\r\nthree")).json()
    moved = await c.post(
        f"/api/notes/{note['id']}/move",
        json={"path": "moved.md", "base_revision": second["revision"]},
        headers=h(c),
    )
    assert moved.status_code == 200
    listing = (await c.get(f"/api/notes/{note['id']}/history")).json()["revisions"]
    assert [(r["revision"], r["reason"], r["path"]) for r in listing] == [
        (3, "move", "moved.md"),
        (2, "write", "h.md"),
        (1, "create", "h.md"),
    ]
    assert all(r["available"] for r in listing)
    first = (await c.get(f"/api/notes/{note['id']}/history/1")).json()
    assert first["content"] == crlf and first["content_hash"] == sha(crlf)
    assert (await c.get(f"/api/notes/{note['id']}/history/3")).json()["content"] == (
        "one\r\ntwo\r\nthree"
    )
    folder = notes_storage.root / ".atlas" / "history" / note["id"]
    assert (folder / f"{sha(crlf)}.md").read_bytes() == crlf.encode()
    assert len(list(folder.iterdir())) == 2, (
        "the move shares the file of the text it did not change"
    )
    assert (await c.get(f"/api/notes/{note['id']}/history/99")).status_code == 404


async def test_history_files_are_invisible_to_listings_and_reconcile(
    c: AsyncClient, notes_storage: NotesStorage
) -> None:
    note = await create(c, "inv.md", "x")
    await put(c, note, "y")
    assert (await c.post("/api/notes/reconcile", headers=h(c))).json() == {
        "added": 0,
        "updated": 0,
        "removed": 0,
        "unchanged": 1,
    }
    assert await live_paths(c) == ["inv.md"]
    assert notes_storage.list_notes() == ["inv.md"]


async def test_non_sync_writes_are_recorded_too(c: AsyncClient) -> None:
    plain = csrf_headers(c)
    note = (
        await c.post("/api/notes", json={"path": "p.md", "content": "a\n"}, headers=plain)
    ).json()
    update = await c.put(
        f"/api/notes/{note['id']}", json={"content": "b\n", "base_revision": 1}, headers=plain
    )
    assert update.status_code == 200
    stale = await c.put(
        f"/api/notes/{note['id']}", json={"content": "c\n", "base_revision": 1}, headers=plain
    )
    assert stale.status_code == 409, "outside sync mode a stale revision is still a plain 409"
    revisions = (await c.get(f"/api/notes/{note['id']}/history")).json()["revisions"]
    assert [r["revision"] for r in revisions] == [2, 1]


async def test_a_note_from_before_history_is_recorded_by_its_next_write(
    c: AsyncClient, notes_storage: NotesStorage
) -> None:
    note = await create(c, "old.md", "legacy\n\nline\n\nend\n")
    async with session_scope() as session:  # as if the note predates the migration
        await session.execute(text("DELETE FROM note_revisions"))
    for file in (notes_storage.root / ".atlas" / "history" / note["id"]).iterdir():
        file.unlink()
    saved = (await put(c, note, "legacy\n\nline\n\nEND\n")).json()
    assert saved["revision"] == 2
    revisions = (await c.get(f"/api/notes/{note['id']}/history")).json()["revisions"]
    assert [(r["revision"], r["reason"]) for r in revisions] == [(2, "write"), (1, "legacy")]
    # so a client still on revision 1 can be merged
    merged = await put(c, note, "LEGACY\n\nline\n\nend\n")
    assert merged.status_code == 200 and merged.json()["content"] == "LEGACY\n\nline\n\nEND\n"


async def test_history_never_crosses_users(c: AsyncClient) -> None:
    from atlas.models import NoteIndex, User

    other_note = uuid.uuid4()
    async with session_scope() as session:
        other = User(
            id=uuid.uuid4(), email="o@example.com", display_name="O", password_hash="not-used"
        )
        session.add(other)
        await session.flush()
        session.add(
            NoteIndex(
                id=other_note,
                user_id=other.id,
                path="theirs.md",
                title="t",
                content_hash=sha("secret"),
                revision=1,
            )
        )
        await session.flush()
        await session.execute(
            text(
                "INSERT INTO note_revisions"
                " (note_id, revision, user_id, content_hash, path, reason)"
                " VALUES (:n, 1, :u, :h, 'theirs.md', 'create')"
            ),
            {"n": other_note, "u": other.id, "h": sha("secret")},
        )
    for suffix in ("history", "history/1"):
        assert (await c.get(f"/api/notes/{other_note}/{suffix}")).status_code == 404
    response = await c.put(
        f"/api/notes/{other_note}",
        json={"content": "x", "base_revision": 1, "base_hash": sha("secret")},
        headers=h(c),
    )
    assert response.status_code == 404, "an edit of another user's note neither revives nor merges"


# --- three-way merge ---------------------------------------------------------------------------


async def test_a_stale_save_that_does_not_overlap_merges_silently(
    c: AsyncClient, notes_storage: NotesStorage
) -> None:
    base = await create(c, "m.md", BASE)
    laptop = (await put(c, base, BASE.replace("alpha", "ALPHA"))).json()
    assert laptop["revision"] == 2
    phone = await put(c, base, BASE.replace("delta", "DELTA"))  # based on revision 1
    assert phone.status_code == 200, phone.text
    body = phone.json()
    expected = BASE.replace("alpha", "ALPHA").replace("delta", "DELTA")
    assert body["content"] == expected and body["revision"] == 3
    assert body["content_hash"] == sha(expected)
    assert body["sync"]["merged"] is True and body["sync"]["revision"] == 3
    assert [r["rule"] for r in body["sync"]["resolution"]] == ["note_merged"]
    assert disk(notes_storage, "m.md") == expected.encode()
    revisions = (await c.get(f"/api/notes/{base['id']}/history")).json()["revisions"]
    assert [(r["revision"], r["reason"]) for r in revisions] == [
        (3, "merge"),
        (2, "write"),
        (1, "create"),
    ]
    # the pre-merge text the laptop saved is still recoverable
    assert (await c.get(f"/api/notes/{base['id']}/history/2")).json()["content"] == (
        BASE.replace("alpha", "ALPHA")
    )
    assert await live_paths(c) == ["m.md"], "a clean merge makes no conflict copy"


async def test_a_merge_keeps_crlf_and_the_missing_final_newline_exactly(
    c: AsyncClient, notes_storage: NotesStorage
) -> None:
    base_text = "# T\r\n\r\none\r\n\r\ntwo\r\n\r\nthree"  # CRLF, no final newline
    base = await create(c, "w.md", base_text)
    await put(c, base, base_text.replace("one", "ONE"))
    appended = await put(c, base, base_text + "\r\n- new")  # appended on the phone
    assert appended.status_code == 200, appended.text
    expected = "# T\r\n\r\nONE\r\n\r\ntwo\r\n\r\nthree\r\n- new"
    assert appended.json()["content"] == expected
    assert disk(notes_storage, "w.md") == expected.encode()


async def test_unicode_and_front_matter_survive_a_merge_byte_for_byte(
    c: AsyncClient, notes_storage: NotesStorage
) -> None:
    base_text = "---\ntitle: Ünï 😀\ntags: [a]\n---\nerste\n\nzweite\n\ndritte\n"
    base = await create(c, "u.md", base_text)
    await put(c, base, base_text.replace("title: Ünï 😀", "title: Ünï 😀 ✓"))
    merged = await put(c, base, base_text.replace("dritte", "DRITTE 日本語"))
    assert merged.status_code == 200
    expected = "---\ntitle: Ünï 😀 ✓\ntags: [a]\n---\nerste\n\nzweite\n\nDRITTE 日本語\n"
    assert disk(notes_storage, "u.md") == expected.encode("utf-8")


async def test_overlapping_edits_never_overwrite_and_are_kept_as_a_conflict_copy(
    c: AsyncClient, notes_storage: NotesStorage
) -> None:
    base = await create(c, "o.md", BASE)
    server_text = BASE.replace("beta", "BETA from the laptop")
    server = (await put(c, base, server_text)).json()
    mine = BASE.replace("beta", "beta from the phone")
    response = await put(c, base, mine)
    assert response.status_code == 409, response.text
    body = response.json()
    assert body["error"] == "conflict" and body["reason"] == "overlap"
    assert body["current_revision"] == server["revision"]
    assert body["current_hash"] == sha(server_text)
    assert body["conflicts"][0]["field"] == "content"
    copy = body["conflict_copy"]
    assert copy["path"].startswith("o (conflict ") and copy["content_hash"] == sha(mine)
    # the note is exactly what the other device saved; the losing text is whole in the copy
    assert disk(notes_storage, "o.md") == server_text.encode()
    assert disk(notes_storage, copy["path"]) == mine.encode()
    note_now = (await c.get(f"/api/notes/{base['id']}")).json()
    assert note_now["revision"] == server["revision"]
    assert copy["path"] in await live_paths(c)
    changes = (await c.get("/api/changes", params={"since": 0})).json()["changes"]
    assert copy["id"] in {item["entity_id"] for item in changes}, "the copy reaches every device"


async def test_a_retried_conflict_replays_without_a_second_copy(c: AsyncClient) -> None:
    base = await create(c, "r.md", BASE)
    await put(c, base, BASE.replace("beta", "B1"))
    key = str(uuid.uuid4())
    first = await put(c, base, BASE.replace("beta", "B2"), key=key)
    again = await put(c, base, BASE.replace("beta", "B2"), key=key)
    assert first.status_code == again.status_code == 409
    assert again.headers["Idempotency-Replayed"] == "true"
    assert again.json()["conflict_copy"] == first.json()["conflict_copy"]
    assert len(await live_paths(c)) == 2


async def test_a_base_that_is_no_longer_retained_is_a_conflict_not_a_guess(
    c: AsyncClient, notes_storage: NotesStorage
) -> None:
    base = await create(c, "g.md", BASE)
    await put(c, base, BASE.replace("alpha", "A2"))
    async with session_scope() as session:  # the base revision was pruned
        await session.execute(text("DELETE FROM note_revisions WHERE revision = 1"))
    mine = BASE.replace("delta", "D2")  # would merge cleanly if the base were known
    response = await put(c, base, mine)
    assert response.status_code == 409 and response.json()["reason"] == "base_unavailable"
    assert disk(notes_storage, response.json()["conflict_copy"]["path"]) == mine.encode()
    assert disk(notes_storage, "g.md") == BASE.replace("alpha", "A2").encode()


async def test_a_base_hash_that_does_not_match_the_retained_text_is_not_merged(
    c: AsyncClient,
) -> None:
    base = await create(c, "bh.md", BASE)
    await put(c, base, BASE.replace("alpha", "A2"))
    lying = {**base, "content_hash": sha("something else")}
    response = await put(c, lying, BASE.replace("delta", "D2"))
    assert response.status_code == 409 and response.json()["reason"] == "base_unavailable"
    current = (await c.get(f"/api/notes/{base['id']}")).json()
    same_revision = await put(c, {**current, "content_hash": sha("other")}, "x")
    assert same_revision.status_code == 409 and same_revision.json()["reason"] == "base_unavailable"


async def test_front_matter_assembled_from_two_sides_is_a_conflict(c: AsyncClient) -> None:
    base_text = "---\ntitle: A\nstatus: draft\naliases: [q]\ntags: [x]\n---\nbody\n"
    base = await create(c, "fm.md", base_text)
    await put(c, base, base_text.replace("title: A", "title: B"))
    response = await put(c, base, base_text.replace("tags: [x]", "tags: [y]"))
    assert response.status_code == 409 and response.json()["reason"] == "front_matter"


async def test_edits_that_change_nothing_do_not_bump_the_revision(c: AsyncClient) -> None:
    base = await create(c, "n.md", BASE)
    server = (await put(c, base, BASE.replace("alpha", "A2"))).json()
    same = await put(c, server, server["content"])  # fast-forward, same text
    assert same.status_code == 200 and same.json()["revision"] == server["revision"]
    untouched = await put(c, base, BASE)  # stale base, the client changed nothing
    assert untouched.status_code == 200
    assert untouched.json()["revision"] == server["revision"]
    assert untouched.json()["content"] == server["content"]
    assert untouched.json()["sync"]["merged"] is True, "the client must take the server's text"
    already = await put(c, base, BASE.replace("alpha", "A2"))  # the same edit, from another device
    assert already.status_code == 200 and already.json()["revision"] == server["revision"]
    assert already.json()["sync"]["merged"] is False


async def test_an_edit_on_the_servers_disk_is_merged_not_overwritten(
    c: AsyncClient, notes_storage: NotesStorage
) -> None:
    """The file was edited outside Atlas and not reconciled yet: it becomes a revision first."""
    base = await create(c, "ext.md", BASE)
    (notes_storage.root / "ext.md").write_bytes(BASE.replace("alpha", "EXTERNAL").encode())
    response = await put(c, base, BASE.replace("delta", "D2"))
    assert response.status_code == 200, response.text
    expected = BASE.replace("alpha", "EXTERNAL").replace("delta", "D2")
    assert disk(notes_storage, "ext.md") == expected.encode()
    assert response.json()["revision"] == 3
    reasons = [
        r["reason"] for r in (await c.get(f"/api/notes/{base['id']}/history")).json()["revisions"]
    ]
    assert reasons == ["merge", "external", "create"]


async def test_the_text_must_be_utf8_and_free_of_nul(c: AsyncClient) -> None:
    note = await create(c, "t.md", "x")
    for bad in ("a\u0000b", "lone \ud800 surrogate"):
        response = await c.put(
            f"/api/notes/{note['id']}",
            content=json.dumps(
                {"content": bad, "base_revision": 1, "base_hash": note["content_hash"]}
            ),
            headers={**h(c), "Content-Type": "application/json"},
        )
        assert response.status_code == 422


# --- replay returns the result, with its content ---------------------------------------------


async def test_a_replayed_merge_returns_the_merged_content(c: AsyncClient) -> None:
    base = await create(c, "rp.md", BASE)
    await put(c, base, BASE.replace("alpha", "ALPHA"))
    key = str(uuid.uuid4())
    first = await put(c, base, BASE.replace("delta", "DELTA"), key=key)
    again = await put(c, base, BASE.replace("delta", "DELTA"), key=key)  # the response was lost
    assert again.headers["Idempotency-Replayed"] == "true"
    assert again.json()["content"] == first.json()["content"]
    assert again.json()["revision"] == first.json()["revision"] == 3
    assert again.json()["sync"] == first.json()["sync"]
    # a later edit does not change what the replay reports: it is the result of the first run
    await put(c, first.json(), "totally new\n")
    third = await put(c, base, BASE.replace("delta", "DELTA"), key=key)
    assert third.json()["content"] == first.json()["content"] and third.json()["revision"] == 3


async def test_replays_of_create_and_move_carry_the_content(c: AsyncClient) -> None:
    key = str(uuid.uuid4())
    body = {"path": "cr.md", "content": "hello\r\n"}
    first = await c.post("/api/notes", json=body, headers=h(c, key))
    again = await c.post("/api/notes", json=body, headers=h(c, key))
    assert again.json()["content"] == "hello\r\n" and again.json()["id"] == first.json()["id"]
    note = first.json()
    mkey = str(uuid.uuid4())
    move = {"path": "cr2.md", "base_revision": 1}
    m1 = await c.post(f"/api/notes/{note['id']}/move", json=move, headers=h(c, mkey))
    m2 = await c.post(f"/api/notes/{note['id']}/move", json=move, headers=h(c, mkey))
    assert m2.headers["Idempotency-Replayed"] == "true"
    assert m2.json()["content"] == "hello\r\n" and m2.json()["path"] == m1.json()["path"]


async def test_a_replay_whose_revision_was_pruned_has_no_content_but_the_summary(
    c: AsyncClient,
) -> None:
    base = await create(c, "pr.md", BASE)
    key = str(uuid.uuid4())
    first = await put(c, base, BASE.replace("alpha", "A2"), key=key)
    async with session_scope() as session:
        await session.execute(text("DELETE FROM note_revisions WHERE revision = 2"))
    again = await put(c, base, BASE.replace("alpha", "A2"), key=key)
    assert again.status_code == 200 and "content" not in again.json()
    assert again.json()["content_hash"] == first.json()["content_hash"]
    assert again.json()["revision"] == 2


# --- delete, revive ---------------------------------------------------------------------------


async def test_a_stale_delete_is_refused_and_the_edit_wins(c: AsyncClient) -> None:
    base = await create(c, "d.md", BASE)
    edited = (await put(c, base, BASE.replace("alpha", "A2"))).json()
    response = await c.delete(f"/api/notes/{base['id']}", params={"base_revision": 1}, headers=h(c))
    assert response.status_code == 409, response.text
    body = response.json()
    assert body["error"] == "edit_wins" and body["current_revision"] == edited["revision"]
    assert body["entity"]["id"] == base["id"] and body["entity"]["path"] == "d.md"
    assert body["resolution"][0]["rule"] == "edit_wins_over_delete"
    assert (await c.get(f"/api/notes/{base['id']}")).status_code == 200
    ok = await c.delete(
        f"/api/notes/{base['id']}",
        params={"base_revision": edited["revision"]},
        headers=h(c),
    )
    assert ok.status_code == 204
    again = await c.delete(f"/api/notes/{base['id']}", params={"base_revision": 1}, headers=h(c))
    assert again.status_code == 204, "deleting a deleted note is an idempotent success"
    future = await create(c, "f.md", "x")
    bad = await c.delete(f"/api/notes/{future['id']}", params={"base_revision": 9}, headers=h(c))
    assert bad.status_code == 409 and bad.json()["error"] == "stale"


async def test_deleting_after_an_unindexed_external_edit_is_refused(
    c: AsyncClient, notes_storage: NotesStorage
) -> None:
    note = await create(c, "xd.md", "one\n")
    (notes_storage.root / "xd.md").write_bytes(b"edited elsewhere\n")
    response = await c.delete(f"/api/notes/{note['id']}", params={"base_revision": 1}, headers=h(c))
    assert response.status_code == 409 and response.json()["error"] == "edit_wins"
    assert disk(notes_storage, "xd.md") == b"edited elsewhere\n"
    assert (await c.get(f"/api/notes/{note['id']}")).json()["revision"] == 2


async def test_an_edit_of_a_deleted_note_brings_it_back(
    c: AsyncClient, notes_storage: NotesStorage
) -> None:
    base = await create(c, "Projects/rv.md", BASE)
    deleted = await c.delete(f"/api/notes/{base['id']}", params={"base_revision": 1}, headers=h(c))
    assert deleted.status_code == 204
    assert not (notes_storage.root / "Projects" / "rv.md").exists()
    mine = BASE.replace("alpha", "edited offline")
    response = await put(c, base, mine)  # based on revision 1, the note is at revision 2 (deleted)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["id"] == base["id"] and body["path"] == "Projects/rv.md"
    assert body["revision"] == 3 and body["content"] == mine
    assert body["sync"]["resolution"][0]["rule"] == "edit_wins_over_delete"
    assert disk(notes_storage, "Projects/rv.md") == mine.encode()
    assert (await c.get(f"/api/notes/{base['id']}")).status_code == 200
    feed = (await c.get("/api/changes", params={"since": 0, "include": "data"})).json()["changes"]
    assert [i["operation"] for i in feed if i["entity_id"] == base["id"]] == ["upsert"]


async def test_the_revived_edit_is_merged_with_the_edits_made_before_the_delete(
    c: AsyncClient, notes_storage: NotesStorage
) -> None:
    base = await create(c, "rm.md", BASE)
    other = (await put(c, base, BASE.replace("alpha", "ALPHA"))).json()
    await c.delete(
        f"/api/notes/{base['id']}", params={"base_revision": other["revision"]}, headers=h(c)
    )
    response = await put(c, base, BASE.replace("delta", "DELTA"))
    assert response.status_code == 200, response.text
    expected = BASE.replace("alpha", "ALPHA").replace("delta", "DELTA")
    assert disk(notes_storage, "rm.md") == expected.encode()
    rules = [r["rule"] for r in response.json()["sync"]["resolution"]]
    assert rules == ["edit_wins_over_delete", "note_merged"]


async def test_an_overlapping_edit_of_a_deleted_note_revives_it_and_keeps_both(
    c: AsyncClient, notes_storage: NotesStorage
) -> None:
    base = await create(c, "ro.md", BASE)
    other = (await put(c, base, BASE.replace("beta", "BETA"))).json()
    await c.delete(
        f"/api/notes/{base['id']}", params={"base_revision": other["revision"]}, headers=h(c)
    )
    mine = BASE.replace("beta", "beta mine")
    response = await put(c, base, mine)
    assert response.status_code == 409 and response.json()["reason"] == "overlap"
    copy = response.json()["conflict_copy"]
    assert disk(notes_storage, "ro.md") == BASE.replace("beta", "BETA").encode()
    assert disk(notes_storage, copy["path"]) == mine.encode()
    assert (await c.get(f"/api/notes/{base['id']}")).status_code == 200, "the note is back"


async def test_a_revive_whose_path_was_reused_gets_a_numbered_name(c: AsyncClient) -> None:
    old = await create(c, "same.md", "old\n")
    await c.delete(f"/api/notes/{old['id']}", params={"base_revision": 1}, headers=h(c))
    other = await create(c, "same.md", "newer\n", id=str(uuid.uuid4()))
    assert other["path"] == "same.md"
    response = await put(c, old, "old edited\n")
    assert response.status_code == 200
    assert response.json()["path"] == "same (2).md"
    assert {r["rule"] for r in response.json()["sync"]["resolution"]} == {
        "edit_wins_over_delete",
        "path_collision",
    }
    assert await live_paths(c) == ["same (2).md", "same.md"]


async def test_a_note_deleted_before_history_is_revived_with_the_clients_text(
    c: AsyncClient,
) -> None:
    note = await create(c, "lg.md", "text\n")
    await c.delete(f"/api/notes/{note['id']}", params={"base_revision": 1}, headers=h(c))
    async with session_scope() as session:
        await session.execute(text("DELETE FROM note_revisions"))
    response = await put(c, note, "client text\n")
    assert response.status_code == 200 and response.json()["content"] == "client text\n"


# --- move -------------------------------------------------------------------------------------


async def move(c: AsyncClient, note: dict[str, Any], path: str, base: int | None = None) -> Any:
    return await c.post(
        f"/api/notes/{note['id']}/move",
        json={"path": path, "base_revision": note["revision"] if base is None else base},
        headers=h(c),
    )


async def test_a_move_ignores_edits_made_since_its_base(c: AsyncClient) -> None:
    note = await create(c, "mv.md", "x\n")
    await put(c, note, "y\n")
    response = await move(c, note, "Archive/mv.md")  # based on revision 1; the note is at 2
    assert response.status_code == 200
    assert response.json()["path"] == "Archive/mv.md" and response.json()["content"] == "y\n"
    assert response.json()["sync"]["resolution"] == []


async def test_two_devices_moving_one_note_the_later_wins_and_is_logged(c: AsyncClient) -> None:
    note = await create(c, "two.md", "x\n")
    assert (await move(c, note, "A/two.md")).status_code == 200
    later = await move(c, note, "B/two.md")  # still based on revision 1
    assert later.status_code == 200 and later.json()["path"] == "B/two.md"
    (res,) = later.json()["sync"]["resolution"]
    assert res["rule"] == "path_later_wins" and "A/two.md" in res["detail"]


async def test_a_move_onto_a_live_note_is_refused_even_by_case(c: AsyncClient) -> None:
    await create(c, "Taken.md", "a\n")
    other = await create(c, "other.md", "b\n")
    for target in ("Taken.md", "taken.md", "TAKEN.MD".replace("MD", "md")):
        response = await move(c, other, target)
        assert response.status_code == 409 and response.json()["error"] == "path_exists", target
    ok = await move(c, other, "other.md")
    assert ok.status_code == 200 and ok.json()["revision"] == 1, "same path: nothing to do"
    recase = await move(c, other, "Other.md")
    assert recase.status_code == 200, "a note never collides with itself"


async def test_a_rename_does_not_bring_a_deleted_note_back(c: AsyncClient) -> None:
    note = await create(c, "gone.md", "x\n")
    await c.delete(f"/api/notes/{note['id']}", params={"base_revision": 1}, headers=h(c))
    response = await move(c, note, "elsewhere.md")
    assert response.status_code == 409 and response.json()["error"] == "note_deleted"
    assert await live_paths(c) == []


async def test_a_move_from_the_future_is_stale(c: AsyncClient) -> None:
    note = await create(c, "fu.md", "x\n")
    response = await move(c, note, "fu2.md", base=7)
    assert response.status_code == 409 and response.json()["error"] == "stale"


async def test_a_folder_rename_keeps_every_note_mergeable(c: AsyncClient) -> None:
    note = await create(c, "Old/fr.md", BASE)
    renamed = await c.post(
        "/api/folders/rename",
        json={"path": "Old", "new_path": "New"},
        headers=csrf_headers(c),
    )
    assert renamed.status_code == 200
    revisions = (await c.get(f"/api/notes/{note['id']}/history")).json()["revisions"]
    assert [(r["revision"], r["reason"], r["path"]) for r in revisions] == [
        (2, "move", "New/fr.md"),
        (1, "create", "Old/fr.md"),
    ]
    merged = await put(c, note, BASE.replace("alpha", "A2"))  # based on the pre-rename revision
    assert merged.status_code == 200 and merged.json()["path"] == "New/fr.md"


# --- portable paths ---------------------------------------------------------------------------

BAD_PATHS = [
    ("CON.md", "reserved_name"),
    ("sub/nul.md", "reserved_name"),
    ("Aux.txt.md", "reserved_name"),
    ("com1.md", "reserved_name"),
    ("LPT9 .md", "reserved_name"),
    ("a:b.md", "forbidden_character"),
    ('q"uote.md', "forbidden_character"),
    ("what?.md", "forbidden_character"),
    ("pipe|.md", "forbidden_character"),
    ("star*.md", "forbidden_character"),
    ("lt<.md", "forbidden_character"),
    ("tab\there.md", "forbidden_character"),
    ("folder./x.md", "trailing_dot_or_space"),
    ("folder /x.md", "trailing_dot_or_space"),
    ("x" * 241, "too_long"),
    ("d/" * 119 + "x", "too_long"),
    ("é" * 128, "name_too_long"),
]


@pytest.mark.parametrize(("path", "reason"), BAD_PATHS)
async def test_sync_mode_refuses_a_path_that_breaks_on_windows_or_android(
    c: AsyncClient, path: str, reason: str
) -> None:
    response = await c.post("/api/notes", json={"path": path, "content": "x"}, headers=h(c))
    assert response.status_code == 422, (path, response.text)
    assert response.json()["error"] == "invalid_path" and response.json()["reason"] == reason
    note = await create(c, "fine.md", "x")
    moved = await move(c, note, path)
    assert moved.status_code == 422 and moved.json()["reason"] == reason
    assert await live_paths(c) == ["fine.md"], "nothing was created or moved"


async def test_the_web_app_outside_sync_mode_keeps_every_path_it_had(c: AsyncClient) -> None:
    plain = csrf_headers(c)
    for path in ("CON.md", "a:b.md"):
        response = await c.post("/api/notes", json={"path": path, "content": "x"}, headers=plain)
        assert response.status_code == 201, path


async def test_a_path_differing_only_by_case_or_normalisation_is_a_collision(
    c: AsyncClient,
) -> None:
    await create(c, "Notes/Résumé.md", "composed")
    lower = await c.post(
        "/api/notes", json={"path": "notes/résumé.md", "content": "x"}, headers=h(c)
    )
    assert lower.json()["path"] == "notes/résumé (2).md"
    decomposed = await c.post(
        "/api/notes", json={"path": "Notes/Résumé.md", "content": "y"}, headers=h(c)
    )
    assert decomposed.json()["path"].endswith("(3).md")
    assert decomposed.json()["sync"]["resolution"][0]["rule"] == "path_collision"


async def test_a_valid_name_at_the_limit_is_accepted(c: AsyncClient) -> None:
    name = "x" * (240 - len(".md"))
    response = await c.post("/api/notes", json={"path": name, "content": "x"}, headers=h(c))
    assert response.status_code == 201 and len(response.json()["path"]) == 240


async def test_a_conflict_copy_name_stays_portable(c: AsyncClient) -> None:
    long_name = "y" * (240 - len(".md"))
    base = await create(c, long_name + ".md"[:0], BASE)
    await put(c, base, BASE.replace("beta", "B1"))
    response = await put(c, base, BASE.replace("beta", "B2"))
    assert response.status_code == 409
    assert len(response.json()["conflict_copy"]["path"]) <= 240


# --- clients may not pass a path on the server's reserved directory --------------------------


async def test_the_reserved_directory_is_still_refused(c: AsyncClient, tmp_path: Path) -> None:
    response = await c.post(
        "/api/notes", json={"path": ".atlas/history/x.md", "content": "x"}, headers=h(c)
    )
    assert response.status_code == 400


# --- concurrency ------------------------------------------------------------------------------


async def test_concurrent_saves_from_one_base_merge_or_conflict_but_never_lose_text(
    c: AsyncClient, notes_storage: NotesStorage
) -> None:
    import asyncio

    base_text = "\n\n".join(f"paragraph {i}" for i in range(12)) + "\n"
    base = await create(c, "cc.md", base_text)
    edits = []
    for index in (0, 4, 8, 11):
        edits.append(base_text.replace(f"paragraph {index}", f"EDITED {index}"))
    responses = await asyncio.gather(*(put(c, base, text_) for text_ in edits))
    assert [r.status_code for r in responses] == [200] * 4, [r.text for r in responses]
    final = disk(notes_storage, "cc.md").decode()
    for index in (0, 4, 8, 11):
        assert f"EDITED {index}" in final
    revisions = (await c.get(f"/api/notes/{base['id']}/history")).json()["revisions"]
    assert [r["revision"] for r in revisions] == [5, 4, 3, 2, 1]

    clash = [base_text.replace("paragraph 6", f"clash {n}") for n in range(3)]
    base2 = (await c.get(f"/api/notes/{base['id']}")).json()
    outcomes = await asyncio.gather(*(put(c, base2, text_) for text_ in clash))
    assert sorted(r.status_code for r in outcomes) == [200, 409, 409]
    notes = (await c.get("/api/notes")).json()["notes"]
    texts = [disk(notes_storage, n["path"]).decode() for n in notes]
    holding = [t for t in texts if "clash" in t]
    assert len(holding) == 3, "the winner and both conflict copies each hold one of the texts"
    found = sorted(re.search(r"clash \d", t).group() for t in holding)  # type: ignore[union-attr]
    assert found == ["clash 0", "clash 1", "clash 2"]
