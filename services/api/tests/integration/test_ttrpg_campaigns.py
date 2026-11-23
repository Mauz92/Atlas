"""Campaigns and sessions linked through the note service (TTRPG-02)."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from atlas.auth import hash_password
from atlas.db import session_scope
from atlas.models import NoteIndex, TtrpgCampaign, TtrpgSession, User
from atlas.notes import NotesStorage
from atlas.ttrpg.templates import extract_section
from tests.conftest import create_user_via_setup, csrf_headers

PASSWORD = "another horse battery"


@pytest.fixture
async def owner(notes_client: AsyncClient) -> AsyncIterator[AsyncClient]:
    await create_user_via_setup(notes_client)
    on = await notes_client.put(
        "/api/features/ttrpg", json={"enabled": True}, headers=csrf_headers(notes_client)
    )
    assert on.status_code == 200
    yield notes_client


def h(client: AsyncClient) -> dict[str, str]:
    return csrf_headers(client)


async def make(client: AsyncClient, **body: Any) -> dict[str, Any]:
    body.setdefault("title", "Lost Mine")
    response = await client.post("/api/ttrpg/campaigns", json=body, headers=h(client))
    assert response.status_code in (200, 201), response.text
    data: dict[str, Any] = response.json()
    return data


async def read_note(client: AsyncClient, note_id: str) -> dict[str, Any]:
    response = await client.get(f"/api/notes/{note_id}")
    assert response.status_code == 200, response.text
    data: dict[str, Any] = response.json()
    return data


async def test_disabled_feature_blocks_every_campaign_route(
    notes_client: AsyncClient,
) -> None:
    await create_user_via_setup(notes_client)
    fake = uuid.uuid4()
    for method, path in (
        ("GET", "/api/ttrpg/campaigns"),
        ("POST", "/api/ttrpg/campaigns"),
        ("GET", f"/api/ttrpg/campaigns/{fake}"),
        ("PATCH", f"/api/ttrpg/campaigns/{fake}"),
        ("POST", f"/api/ttrpg/campaigns/{fake}/sessions"),
        ("POST", f"/api/ttrpg/campaigns/{fake}/relink"),
        ("GET", f"/api/ttrpg/sessions/{fake}"),
        ("PATCH", f"/api/ttrpg/sessions/{fake}"),
    ):
        response = await notes_client.request(
            method, path, json={"title": "x"} if method != "GET" else None, headers=h(notes_client)
        )
        assert response.status_code == 404, (method, path, response.status_code)


async def test_creating_a_campaign_scaffolds_real_markdown_notes(
    owner: AsyncClient, notes_storage: NotesStorage
) -> None:
    created = await make(owner, title="Lost Mine of Phandelver", book_title="LMoP")
    assert created["folder"] == "TTRPG/Lost Mine of Phandelver"
    assert created["rules_preset"] == "dnd5e-2014"
    assert created["archived"] is False and created["revision"] == 1
    home = created["home"]
    assert home["missing"] is False
    assert home["path"] == "TTRPG/Lost Mine of Phandelver/Campaign Home.md"
    (first,) = created["sessions"]
    assert (
        first["sequence"] == 1 and first["title"] == "Session 01" and first["status"] == "planned"
    )
    assert first["note"]["path"] == "TTRPG/Lost Mine of Phandelver/Sessions/Session 01.md"

    # ordinary Markdown files, readable outside Atlas
    home_text = notes_storage.read(home["path"]).content
    assert home_text.startswith("# Lost Mine of Phandelver") and "Book: LMoP" in home_text
    text = notes_storage.read(first["note"]["path"]).content
    for heading in (
        "Where we left off",
        "Book references",
        "Prep",
        "During play",
        "Next session",
    ):
        assert f"## {heading}" in text
    # and visible through the ordinary notes API
    assert (await read_note(owner, home["note_id"]))["path"] == home["path"]


async def test_enabling_the_feature_creates_no_campaign_or_notes(
    notes_client: AsyncClient, notes_storage: NotesStorage
) -> None:
    await create_user_via_setup(notes_client)
    await notes_client.put("/api/features/ttrpg", json={"enabled": True}, headers=h(notes_client))
    assert (await notes_client.get("/api/ttrpg/campaigns")).json() == {"items": []}
    assert not (notes_storage.root / "TTRPG").exists()


async def test_retrying_a_create_with_the_same_id_is_idempotent(owner: AsyncClient) -> None:
    cid = str(uuid.uuid4())
    first = await owner.post(
        "/api/ttrpg/campaigns", json={"id": cid, "title": "A"}, headers=h(owner)
    )
    again = await owner.post(
        "/api/ttrpg/campaigns", json={"id": cid, "title": "A"}, headers=h(owner)
    )
    assert (first.status_code, again.status_code) == (201, 200)
    assert first.json()["id"] == again.json()["id"] == cid
    assert len(again.json()["sessions"]) == 1
    notes = (await owner.get("/api/notes")).json()["notes"]
    assert len([n for n in notes if n["path"].startswith("TTRPG/A/")]) == 2


async def test_retry_after_a_partial_scaffold_adopts_files_without_overwriting(
    owner: AsyncClient, notes_storage: NotesStorage, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A create dies after the home file was written (its transaction rolls back).

    The retry adopts the leftover file, keeps what a person wrote in it and completes the rest,
    with no duplicates.
    """
    from atlas.ttrpg import campaigns as module

    original = module.CampaignService._add_session

    async def boom(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("simulated crash before the session note")

    monkeypatch.setattr(module.CampaignService, "_add_session", boom)
    cid = str(uuid.uuid4())
    with pytest.raises(RuntimeError):
        await owner.post(
            "/api/ttrpg/campaigns", json={"id": cid, "title": "Crash"}, headers=h(owner)
        )
    monkeypatch.setattr(module.CampaignService, "_add_session", original)

    # the rolled-back attempt left the home file but no rows
    home_file = "TTRPG/Crash/Campaign Home.md"
    assert notes_storage.exists(home_file)
    async with session_scope() as session:
        assert (await session.execute(select(TtrpgCampaign))).first() is None
        assert (await session.execute(select(NoteIndex))).first() is None
    notes_storage.absolute(home_file).write_text("# Crash\n\nMY OWN WORDS\n", encoding="utf-8")

    retry = await owner.post(
        "/api/ttrpg/campaigns", json={"id": cid, "title": "Crash"}, headers=h(owner)
    )
    assert retry.status_code == 201, retry.text
    body = retry.json()
    assert "MY OWN WORDS" in notes_storage.read(home_file).content
    assert body["home"]["path"] == home_file and body["home"]["missing"] is False
    assert len(body["sessions"]) == 1
    async with session_scope() as session:
        paths = sorted((await session.scalars(select(NoteIndex.path))).all())
    assert paths == [home_file, "TTRPG/Crash/Sessions/Session 01.md"]


async def test_folder_collisions_and_unsafe_folders(owner: AsyncClient) -> None:
    await make(owner, title="One", folder="Games/Shared")
    clash = await owner.post(
        "/api/ttrpg/campaigns", json={"title": "Two", "folder": "Games/Shared"}, headers=h(owner)
    )
    assert clash.status_code == 409
    for folder in ("../escape", "/abs", ".atlas/x", "a/../../b"):
        bad = await owner.post(
            "/api/ttrpg/campaigns", json={"title": "Bad", "folder": folder}, headers=h(owner)
        )
        assert bad.status_code == 400, (folder, bad.text)
    assert len((await owner.get("/api/ttrpg/campaigns")).json()["items"]) == 1


@pytest.mark.parametrize(
    "body",
    [
        {"title": "   "},
        {"title": "x" * 201},
        {"title": "ok", "rules_preset": "pf2e"},
        {"title": "ok", "unknown": 1},
        {},
    ],
)
async def test_invalid_create_requests_change_nothing(
    owner: AsyncClient, body: dict[str, Any]
) -> None:
    response = await owner.post("/api/ttrpg/campaigns", json=body, headers=h(owner))
    assert response.status_code in (400, 422)
    assert (await owner.get("/api/ttrpg/campaigns")).json() == {"items": []}


async def test_title_with_path_characters_becomes_a_safe_folder(owner: AsyncClient) -> None:
    created = await make(owner, title="Curse/of: Strahd?")
    assert created["folder"] == "TTRPG/Curse of Strahd"


async def test_notes_keep_their_association_through_a_move(owner: AsyncClient) -> None:
    created = await make(owner)
    session_note = created["sessions"][0]["note"]
    moved = await owner.post(
        f"/api/notes/{session_note['note_id']}/move",
        json={"path": "Elsewhere/Renamed Session.md"},
        headers=h(owner),
    )
    assert moved.status_code == 200, moved.text
    detail = (await owner.get(f"/api/ttrpg/campaigns/{created['id']}")).json()
    note = detail["sessions"][0]["note"]
    assert note["note_id"] == session_note["note_id"]
    assert note["path"] == "Elsewhere/Renamed Session.md" and note["missing"] is False


async def test_a_deleted_note_is_reported_missing_and_can_be_relinked_or_recreated(
    owner: AsyncClient, notes_storage: NotesStorage
) -> None:
    created = await make(owner)
    cid = created["id"]
    sid = created["sessions"][0]["id"]
    home_id = created["home"]["note_id"]
    note_id = created["sessions"][0]["note"]["note_id"]
    assert (await owner.delete(f"/api/notes/{note_id}", headers=h(owner))).status_code == 204
    assert (await owner.delete(f"/api/notes/{home_id}", headers=h(owner))).status_code == 204

    detail = (await owner.get(f"/api/ttrpg/campaigns/{cid}")).json()
    assert detail["sessions"][0]["note"]["missing"] is True
    assert detail["home"]["missing"] is True
    # history stays reachable
    assert (await owner.get(f"/api/ttrpg/sessions/{sid}")).status_code == 200

    # relink the session to a different existing note
    other = await owner.post(
        "/api/notes", json={"path": "Mine/Replacement.md", "content": "# R"}, headers=h(owner)
    )
    fixed = await owner.post(
        f"/api/ttrpg/campaigns/{cid}/relink",
        json={"target": sid, "note_id": other.json()["id"]},
        headers=h(owner),
    )
    assert fixed.status_code == 200, fixed.text
    assert fixed.json()["sessions"][0]["note"]["path"] == "Mine/Replacement.md"
    # recreate the home note at its standard path
    again = await owner.post(
        f"/api/ttrpg/campaigns/{cid}/relink", json={"target": "home"}, headers=h(owner)
    )
    assert again.status_code == 200, again.text
    assert again.json()["home"]["missing"] is False
    assert notes_storage.exists(again.json()["home"]["path"])
    # a healthy link is not touched, and the same note cannot serve two links
    healthy = await owner.post(
        f"/api/ttrpg/campaigns/{cid}/relink", json={"target": "home"}, headers=h(owner)
    )
    assert healthy.status_code == 400


async def test_a_note_cannot_be_linked_twice_nor_a_foreign_one(
    app: FastAPI, owner: AsyncClient
) -> None:
    created = await make(owner)
    cid, sid = created["id"], created["sessions"][0]["id"]
    second = (
        await owner.post(
            f"/api/ttrpg/campaigns/{cid}/sessions", json={"title": "Two"}, headers=h(owner)
        )
    ).json()
    await owner.delete(f"/api/notes/{second['note']['note_id']}", headers=h(owner))
    clash = await owner.post(
        f"/api/ttrpg/campaigns/{cid}/relink",
        json={"target": second["id"], "note_id": created["sessions"][0]["note"]["note_id"]},
        headers=h(owner),
    )
    assert clash.status_code == 400
    missing = await owner.post(
        f"/api/ttrpg/campaigns/{cid}/relink",
        json={"target": second["id"], "note_id": str(uuid.uuid4())},
        headers=h(owner),
    )
    assert missing.status_code == 404
    bad_target = await owner.post(
        f"/api/ttrpg/campaigns/{cid}/relink", json={"target": "nope"}, headers=h(owner)
    )
    assert bad_target.status_code == 400
    assert sid  # first session untouched


async def test_sessions_number_up_carry_the_handoff_and_expose_it(
    owner: AsyncClient, notes_storage: NotesStorage
) -> None:
    created = await make(owner)
    cid = created["id"]
    first = created["sessions"][0]
    note = await read_note(owner, first["note"]["note_id"])
    body = note["content"].replace(
        "## Next session\n", "## Next session\n\nThe goblins ambush the wagon.\n"
    )
    saved = await owner.put(
        f"/api/notes/{note['id']}",
        json={"content": body, "base_revision": note["revision"]},
        headers=h(owner),
    )
    assert saved.status_code == 200, saved.text

    sid = str(uuid.uuid4())
    one = await owner.post(
        f"/api/ttrpg/campaigns/{cid}/sessions", json={"id": sid}, headers=h(owner)
    )
    retry = await owner.post(
        f"/api/ttrpg/campaigns/{cid}/sessions", json={"id": sid}, headers=h(owner)
    )
    assert (one.status_code, retry.status_code) == (201, 200)
    assert one.json()["sequence"] == 2 and one.json()["title"] == "Session 02"
    previous = one.json()["previous"]
    assert previous["session_id"] == first["id"]
    assert previous["handoff"] == "The goblins ambush the wagon."
    # the new session's own note opens with the handoff, and the first session has no previous
    new_note = await read_note(owner, one.json()["note"]["note_id"])
    assert "The goblins ambush the wagon." in extract_section(
        new_note["content"], "Where we left off"
    )
    assert (await owner.get(f"/api/ttrpg/sessions/{first['id']}")).json()["previous"] is None
    assert (await owner.get(f"/api/ttrpg/sessions/{sid}")).json()["previous"]["handoff"]
    # duplicate titles never collide on a path
    dup = await owner.post(
        f"/api/ttrpg/campaigns/{cid}/sessions", json={"title": "Session 02"}, headers=h(owner)
    )
    assert dup.status_code == 201
    assert dup.json()["note"]["path"] != one.json()["note"]["path"]


async def test_session_updates_are_revision_checked_and_one_session_is_active(
    owner: AsyncClient,
) -> None:
    created = await make(owner)
    cid = created["id"]
    one = created["sessions"][0]
    two = (
        await owner.post(f"/api/ttrpg/campaigns/{cid}/sessions", json={}, headers=h(owner))
    ).json()

    started = await owner.patch(
        f"/api/ttrpg/sessions/{one['id']}",
        json={"base_revision": 1, "status": "active", "session_date": "2026-11-23"},
        headers=h(owner),
    )
    assert started.status_code == 200, started.text
    assert started.json()["status"] == "active" and started.json()["revision"] == 2
    assert started.json()["session_date"] == "2026-11-23"

    stale = await owner.patch(
        f"/api/ttrpg/sessions/{one['id']}",
        json={"base_revision": 1, "title": "Stale"},
        headers=h(owner),
    )
    assert stale.status_code == 409 and stale.json()["detail"]["current_revision"] == 2

    second_active = await owner.patch(
        f"/api/ttrpg/sessions/{two['id']}",
        json={"base_revision": 1, "status": "active"},
        headers=h(owner),
    )
    assert second_active.status_code == 400
    done = await owner.patch(
        f"/api/ttrpg/sessions/{one['id']}",
        json={"base_revision": 2, "status": "done", "session_date": None},
        headers=h(owner),
    )
    assert done.json()["status"] == "done" and done.json()["session_date"] is None
    assert (
        await owner.patch(
            f"/api/ttrpg/sessions/{one['id']}",
            json={"base_revision": 3, "status": "bogus"},
            headers=h(owner),
        )
    ).status_code == 422


async def test_campaign_updates_archive_and_block_new_sessions(owner: AsyncClient) -> None:
    created = await make(owner, book_title="Book")
    cid = created["id"]
    renamed = await owner.patch(
        f"/api/ttrpg/campaigns/{cid}",
        json={"base_revision": 1, "title": "Renamed", "book_title": None},
        headers=h(owner),
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["title"] == "Renamed" and renamed.json()["book_title"] is None
    assert renamed.json()["revision"] == 2
    # an omitted book_title is left alone
    untouched = await owner.patch(
        f"/api/ttrpg/campaigns/{cid}", json={"base_revision": 2, "title": "R2"}, headers=h(owner)
    )
    assert untouched.json()["revision"] == 3
    stale = await owner.patch(
        f"/api/ttrpg/campaigns/{cid}", json={"base_revision": 1, "title": "x"}, headers=h(owner)
    )
    assert stale.status_code == 409
    archived = await owner.patch(
        f"/api/ttrpg/campaigns/{cid}", json={"base_revision": 3, "archived": True}, headers=h(owner)
    )
    assert archived.json()["archived"] is True
    assert (await owner.get("/api/ttrpg/campaigns")).json() == {"items": []}
    listed = (await owner.get("/api/ttrpg/campaigns?include_archived=true")).json()["items"]
    assert [c["id"] for c in listed] == [cid]
    blocked = await owner.post(f"/api/ttrpg/campaigns/{cid}/sessions", json={}, headers=h(owner))
    assert blocked.status_code == 400
    restored = await owner.patch(
        f"/api/ttrpg/campaigns/{cid}",
        json={"base_revision": 4, "archived": False},
        headers=h(owner),
    )
    assert restored.json()["archived"] is False


async def test_other_accounts_cannot_see_or_touch_a_campaign(
    app: FastAPI, owner: AsyncClient
) -> None:
    created = await make(owner)
    cid, sid = created["id"], created["sessions"][0]["id"]
    async with session_scope() as session:
        session.add(
            User(email="two@example.com", display_name="Two", password_hash=hash_password(PASSWORD))
        )
    other = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    try:
        login = await other.post(
            "/api/auth/login", json={"email": "two@example.com", "password": PASSWORD}
        )
        assert login.status_code == 200
        await other.put("/api/features/ttrpg", json={"enabled": True}, headers=h(other))
        assert (await other.get("/api/ttrpg/campaigns")).json() == {"items": []}
        for method, path, body in (
            ("GET", f"/api/ttrpg/campaigns/{cid}", None),
            ("PATCH", f"/api/ttrpg/campaigns/{cid}", {"base_revision": 1, "title": "x"}),
            ("POST", f"/api/ttrpg/campaigns/{cid}/sessions", {}),
            ("POST", f"/api/ttrpg/campaigns/{cid}/relink", {"target": "home"}),
            ("GET", f"/api/ttrpg/sessions/{sid}", None),
            ("PATCH", f"/api/ttrpg/sessions/{sid}", {"base_revision": 1, "title": "x"}),
        ):
            response = await other.request(method, path, json=body, headers=h(other))
            assert response.status_code == 404, (method, path, response.status_code)
        # reusing the other account's id is refused without revealing it
        taken = await other.post(
            "/api/ttrpg/campaigns", json={"id": cid, "title": "Mine"}, headers=h(other)
        )
        assert taken.status_code == 409
    finally:
        await other.aclose()
    async with session_scope() as session:
        assert (await session.scalar(select(TtrpgCampaign.title))) == "Lost Mine"
        assert len((await session.scalars(select(TtrpgSession.id))).all()) == 1


async def test_disabling_and_re_enabling_keeps_the_campaign_and_notes(
    owner: AsyncClient, notes_storage: NotesStorage
) -> None:
    created = await make(owner)
    off = await owner.put("/api/features/ttrpg", json={"enabled": False}, headers=h(owner))
    assert off.status_code == 200
    assert (await owner.get(f"/api/ttrpg/campaigns/{created['id']}")).status_code == 404
    assert notes_storage.exists(created["home"]["path"])
    await owner.put("/api/features/ttrpg", json={"enabled": True}, headers=h(owner))
    again = (await owner.get(f"/api/ttrpg/campaigns/{created['id']}")).json()
    assert again["home"]["path"] == created["home"]["path"]


def test_extract_section_handles_levels_fences_and_absence() -> None:
    text = (
        "# T\n\n## Next session\nline one\n```\n## not a heading\n```\n"
        "### sub\nkeep\n\n## After\nno\n"
    )
    assert (
        extract_section(text, "next session")
        == "line one\n```\n## not a heading\n```\n### sub\nkeep"
    )
    assert extract_section("## Next session\n\n## After\n", "Next session") == ""
    assert extract_section("# nothing\n", "Next session") is None


async def test_the_campaign_collects_its_notes_while_they_stay_beside_the_others(
    owner: AsyncClient, notes_storage: NotesStorage
) -> None:
    created = await make(owner, title="Phandelver")
    cid = created["id"]
    two = (
        await owner.post(f"/api/ttrpg/campaigns/{cid}/sessions", json={}, headers=h(owner))
    ).json()
    npc = await owner.post(
        f"/api/ttrpg/campaigns/{cid}/notes",
        json={"kind": "npc", "title": "Sildar Hallwinter"},
        headers=h(owner),
    )
    assert npc.status_code == 201, npc.text
    assert npc.json()["path"] == "TTRPG/Phandelver/NPCs/Sildar Hallwinter.md"
    assert npc.json()["kind"] == "npc"
    loc = await owner.post(
        f"/api/ttrpg/campaigns/{cid}/notes",
        json={"kind": "location", "title": "Cragmaw Hideout"},
        headers=h(owner),
    )
    assert loc.json()["path"].endswith("Locations/Cragmaw Hideout.md")
    plain = await owner.post(
        f"/api/ttrpg/campaigns/{cid}/notes",
        json={"kind": "note", "title": "Loot list"},
        headers=h(owner),
    )
    assert plain.json()["kind"] == "other"
    # a note typed into the folder by hand, and an unrelated note elsewhere
    await owner.post(
        "/api/notes",
        json={"path": "TTRPG/Phandelver/Rumours.md", "content": "# R"},
        headers=h(owner),
    )
    await owner.post("/api/notes", json={"path": "Shopping.md", "content": "# S"}, headers=h(owner))

    items = (await owner.get(f"/api/ttrpg/campaigns/{cid}/notes")).json()["items"]
    assert [(i["kind"], i["title"]) for i in items] == [
        ("home", "Phandelver"),
        ("session", "Session 01"),
        ("session", "Session 02"),
        ("npc", "Sildar Hallwinter"),
        ("location", "Cragmaw Hideout"),
        ("other", "Loot list"),
        ("other", "R"),  # titled by its own heading
    ]
    assert [i["label"] for i in items if i["kind"] == "session"] == [
        "1. Session 01",
        "2. Session 02",
    ]
    assert "Shopping" not in [i["title"] for i in items]
    # real Markdown with a heading, listed in the ordinary notes too
    text = notes_storage.read(npc.json()["path"]).content
    assert text.startswith("# Sildar Hallwinter") and "## Who they are" in text
    everything = (await owner.get("/api/notes")).json()["notes"]
    assert npc.json()["id"] in [n["id"] for n in everything]

    # a session note moved out of the folder still belongs to the campaign
    moved = await owner.post(
        f"/api/notes/{two['note']['note_id']}/move",
        json={"path": "Elsewhere/Second night.md"},
        headers=h(owner),
    )
    assert moved.status_code == 200
    after = (await owner.get(f"/api/ttrpg/campaigns/{cid}/notes")).json()["items"]
    moved_item = next(i for i in after if i["kind"] == "session" and i["label"] == "2. Session 02")
    assert moved_item["path"] == "Elsewhere/Second night.md"
    # a deleted linked note drops out (it is reported missing on the campaign page instead)
    await owner.delete(f"/api/notes/{two['note']['note_id']}", headers=h(owner))
    gone = (await owner.get(f"/api/ttrpg/campaigns/{cid}/notes")).json()["items"]
    assert "2. Session 02" not in [i["label"] for i in gone]


async def test_new_campaign_notes_are_safe_and_never_overwrite(owner: AsyncClient) -> None:
    cid = (await make(owner, title="Safe"))["id"]
    url = f"/api/ttrpg/campaigns/{cid}/notes"
    one = await owner.post(url, json={"kind": "npc", "title": "Klarg/../x"}, headers=h(owner))
    assert one.status_code == 201
    assert (
        one.json()["path"].count("/") == 3
    )  # one file inside NPCs/, no path segments from the title
    assert one.json()["path"].startswith("TTRPG/Safe/NPCs/")
    a = await owner.post(url, json={"kind": "npc", "title": "Twin"}, headers=h(owner))
    b = await owner.post(url, json={"kind": "npc", "title": "Twin"}, headers=h(owner))
    assert a.status_code == b.status_code == 201 and a.json()["path"] != b.json()["path"]
    blank = await owner.post(url, json={"kind": "npc", "title": "  "}, headers=h(owner))
    assert blank.status_code == 400  # refused by the service: nothing is written
    for bad in ({"kind": "monster", "title": "x"}, {"kind": "npc"}):
        assert (await owner.post(url, json=bad, headers=h(owner))).status_code == 422
    await owner.patch(
        f"/api/ttrpg/campaigns/{cid}", json={"base_revision": 1, "archived": True}, headers=h(owner)
    )
    assert (
        await owner.post(url, json={"kind": "npc", "title": "Late"}, headers=h(owner))
    ).status_code == 400


async def test_the_collected_notes_are_per_owner_and_behind_the_switch(
    app: FastAPI, owner: AsyncClient
) -> None:
    cid = (await make(owner, title="Mine"))["id"]
    async with session_scope() as session:
        session.add(
            User(email="two@example.com", display_name="Two", password_hash=hash_password(PASSWORD))
        )
    other = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    try:
        await other.post("/api/auth/login", json={"email": "two@example.com", "password": PASSWORD})
        await other.put("/api/features/ttrpg", json={"enabled": True}, headers=h(other))
        assert (await other.get(f"/api/ttrpg/campaigns/{cid}/notes")).status_code == 404
        made = await other.post(
            f"/api/ttrpg/campaigns/{cid}/notes",
            json={"kind": "npc", "title": "X"},
            headers=h(other),
        )
        assert made.status_code == 404
    finally:
        await other.aclose()
    await owner.put("/api/features/ttrpg", json={"enabled": False}, headers=h(owner))
    assert (await owner.get(f"/api/ttrpg/campaigns/{cid}/notes")).status_code == 404
