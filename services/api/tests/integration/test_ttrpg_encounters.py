"""Prepared encounters, slots, snapshots and note launch links (TTRPG-05)."""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select

from atlas.api.ttrpg import get_srd_catalog
from atlas.auth import hash_password
from atlas.db import session_scope
from atlas.models import TtrpgEncounter, TtrpgEncounterSlot, User
from atlas.notes import NotesStorage
from atlas.ttrpg.encounters import insert_under_prep
from atlas.ttrpg.srd import HttpSrdCatalog
from tests.conftest import create_user_via_setup, csrf_headers
from tests.fakes.srd_provider import GOBLIN, FakeSrd


def h(client: AsyncClient) -> dict[str, str]:
    return csrf_headers(client)


@pytest.fixture
def srd(app: FastAPI) -> FakeSrd:
    fake = FakeSrd()
    catalog = HttpSrdCatalog("https://srd.example", transport=fake.transport(), timeout=2.0)
    app.dependency_overrides[get_srd_catalog] = lambda: catalog
    return fake


@pytest.fixture
async def owner(notes_client: AsyncClient, srd: FakeSrd) -> AsyncIterator[AsyncClient]:
    await create_user_via_setup(notes_client)
    await notes_client.put("/api/features/ttrpg", json={"enabled": True}, headers=h(notes_client))
    yield notes_client


@pytest.fixture
async def campaign(owner: AsyncClient) -> dict[str, Any]:
    response = await owner.post(
        "/api/ttrpg/campaigns", json={"title": "Phandelver"}, headers=h(owner)
    )
    assert response.status_code == 201
    data: dict[str, Any] = response.json()
    return data


async def goblin_card(owner: AsyncClient) -> dict[str, Any]:
    response = await owner.post("/api/ttrpg/srd/import", json={"index": "goblin"}, headers=h(owner))
    assert response.status_code in (200, 201), response.text
    data: dict[str, Any] = response.json()
    return data


async def make(owner: AsyncClient, cid: str, **body: Any) -> dict[str, Any]:
    body.setdefault("title", "Goblin ambush")
    response = await owner.post(
        f"/api/ttrpg/campaigns/{cid}/encounters", json=body, headers=h(owner)
    )
    assert response.status_code in (200, 201), response.text
    data: dict[str, Any] = response.json()
    return data


async def add_slots(owner: AsyncClient, enc: dict[str, Any], **spec: Any) -> dict[str, Any]:
    response = await owner.post(
        f"/api/ttrpg/encounters/{enc['id']}/slots",
        json={"base_revision": enc["revision"], **spec},
        headers=h(owner),
    )
    assert response.status_code == 200, response.text
    data: dict[str, Any] = response.json()
    return data


async def party_member(owner: AsyncClient, cid: str, name: str = "Brenna") -> dict[str, Any]:
    response = await owner.post(
        f"/api/ttrpg/campaigns/{cid}/party",
        json={"name": name, "ac": 17, "max_hp": 28},
        headers=h(owner),
    )
    assert response.status_code == 201
    data: dict[str, Any] = response.json()
    return data


async def test_prepare_the_phandelver_ambush(owner: AsyncClient, campaign: dict[str, Any]) -> None:
    cid = campaign["id"]
    session_id = campaign["sessions"][0]["id"]
    fighter = await party_member(owner, cid)
    companion = await party_member(owner, cid, "Sildar")
    card = await goblin_card(owner)

    enc = await make(
        owner,
        cid,
        book_reference="p. 6, Goblin Arrows",
        setup_reminder="Two goblins hide in the brush; the wagon blocks the road.",
        session_id=session_id,
        party_member_ids=[fighter["id"], companion["id"]],
    )
    assert enc["revision"] == 1 and enc["slots"] == []
    assert enc["path"] == f"/ttrpg/encounters/{enc['id']}"
    assert enc["link"] == f"[Goblin ambush]({enc['path']})"
    assert enc["session_title"] == "Session 01"
    assert [p["name"] for p in enc["party"]] == ["Brenna", "Sildar"]

    enc = await add_slots(owner, enc, creature_id=card["id"], count=3)
    assert [s["name"] for s in enc["slots"]] == ["Goblin 1", "Goblin 2", "Goblin 3"]
    assert {(s["ac"], s["hp"], s["initiative_mod"]) for s in enc["slots"]} == {(15, 7, 2)}
    assert all(s["overrides"] == [] and s["side"] == "enemy" for s in enc["slots"])
    assert enc["slots"][0]["snapshot"]["actions"][0]["name"] == "Scimitar"
    assert enc["slots"][0]["snapshot"]["attribution"]  # provenance travels with the copy
    assert enc["revision"] == 2

    # one manual override: the first goblin is tougher at this table
    first = enc["slots"][0]["id"]
    tuned = await owner.patch(
        f"/api/ttrpg/encounters/{enc['id']}/slots/{first}",
        json={"base_revision": 2, "name": "Klarg's lookout", "hp": 12},
        headers=h(owner),
    )
    assert tuned.status_code == 200, tuned.text
    slot = tuned.json()["slots"][0]
    assert (slot["name"], slot["hp"], slot["ac"]) == ("Klarg's lookout", 12, 15)
    assert sorted(slot["overrides"]) == ["hp", "name"]
    assert [s["hp"] for s in tuned.json()["slots"][1:]] == [7, 7]  # independent slots
    assert tuned.json()["revision"] == 3


async def test_slots_can_be_custom_allied_or_added_in_several_batches(
    owner: AsyncClient, campaign: dict[str, Any]
) -> None:
    cid = campaign["id"]
    card = await goblin_card(owner)
    enc = await make(owner, cid)
    enc = await add_slots(owner, enc, creature_id=card["id"], count=2)
    enc = await add_slots(owner, enc, creature_id=card["id"])  # numbering continues
    assert [s["name"] for s in enc["slots"]] == ["Goblin 1", "Goblin 2", "Goblin 3"]
    enc = await add_slots(owner, enc, name="Hired muscle", ac=14, hp=11, side="ally")
    custom = enc["slots"][-1]
    assert (custom["name"], custom["creature_id"], custom["side"]) == ("Hired muscle", None, "ally")
    assert custom["snapshot"] == {} and custom["overrides"] == []
    enc = await add_slots(owner, enc, name="Hired muscle", ac=14, hp=11)
    assert enc["slots"][-1]["name"] == "Hired muscle 2"  # names stay distinguishable
    # a card with explicit overrides records them
    enc = await add_slots(owner, enc, creature_id=card["id"], hp=20, name="Boss goblin")
    assert sorted(enc["slots"][-1]["overrides"]) == ["hp", "name"]
    assert enc["slots"][-1]["ac"] == 15


@pytest.mark.parametrize(
    "spec",
    [
        {},  # neither a card nor a custom entry
        {"name": "x"},  # custom without AC/HP
        {"name": "x", "ac": 10},
        {"creature_id": str(uuid.uuid4())},  # unknown card
        {"name": "x", "ac": 10, "hp": 0},
        {"name": "x", "ac": 10, "hp": 5, "count": 0},
        {"name": "x", "ac": 10, "hp": 5, "count": 61},
        {"name": "x", "ac": 10, "hp": 5, "side": "neutral"},
        {"name": "x", "ac": 10, "hp": 5, "bogus": 1},
    ],
)
async def test_invalid_slot_requests_change_nothing(
    owner: AsyncClient, campaign: dict[str, Any], spec: dict[str, Any]
) -> None:
    enc = await make(owner, campaign["id"])
    response = await owner.post(
        f"/api/ttrpg/encounters/{enc['id']}/slots",
        json={"base_revision": 1, **spec},
        headers=h(owner),
    )
    assert response.status_code in (400, 404, 422), response.text
    after = (await owner.get(f"/api/ttrpg/encounters/{enc['id']}")).json()
    assert after["slots"] == [] and after["revision"] == 1


async def test_an_archived_card_cannot_be_prepared_and_slot_limit(
    owner: AsyncClient, campaign: dict[str, Any]
) -> None:
    cid = campaign["id"]
    card = (
        await owner.post(
            "/api/ttrpg/creatures", json={"name": "Old", "ac": 10, "hp": 4}, headers=h(owner)
        )
    ).json()
    await owner.post(
        f"/api/ttrpg/creatures/{card['id']}/archive",
        json={"base_revision": 1, "archived": True},
        headers=h(owner),
    )
    enc = await make(owner, cid)
    refused = await owner.post(
        f"/api/ttrpg/encounters/{enc['id']}/slots",
        json={"base_revision": 1, "creature_id": card["id"]},
        headers=h(owner),
    )
    assert refused.status_code == 400
    full = await add_slots(owner, enc, name="Rat", ac=10, hp=1, count=60)
    assert len(full["slots"]) == 60
    over = await owner.post(
        f"/api/ttrpg/encounters/{enc['id']}/slots",
        json={"base_revision": full["revision"], "name": "Rat", "ac": 10, "hp": 1},
        headers=h(owner),
    )
    assert over.status_code == 400


async def test_snapshots_stay_stable_when_the_card_changes_until_an_explicit_refresh(
    owner: AsyncClient, campaign: dict[str, Any], srd: FakeSrd
) -> None:
    card = await goblin_card(owner)
    enc = await make(owner, campaign["id"])
    enc = await add_slots(owner, enc, creature_id=card["id"], count=2)
    first, second = enc["slots"][0]["id"], enc["slots"][1]["id"]
    await owner.patch(
        f"/api/ttrpg/encounters/{enc['id']}/slots/{first}",
        json={"base_revision": enc["revision"], "hp": 30, "name": "Tough"},
        headers=h(owner),
    )
    # the catalogue changes and the card is refreshed: the encounter does not notice
    srd.monsters["goblin"] = {**GOBLIN, "hit_points": 9, "armor_class": [{"value": 16}]}
    refreshed_card = await owner.post(
        f"/api/ttrpg/creatures/{card['id']}/refresh", json={"base_revision": 1}, headers=h(owner)
    )
    assert refreshed_card.json()["hp"] == 9
    seen = (await owner.get(f"/api/ttrpg/encounters/{enc['id']}")).json()
    assert [(s["ac"], s["hp"]) for s in seen["slots"]] == [(15, 30), (15, 7)]
    assert seen["slots"][1]["snapshot"]["creature_revision"] == 1

    refreshed = await owner.post(
        f"/api/ttrpg/encounters/{enc['id']}/refresh",
        json={"base_revision": seen["revision"]},
        headers=h(owner),
    )
    assert refreshed.status_code == 200, refreshed.text
    body = refreshed.json()
    by_id = {s["id"]: s for s in body["encounter"]["slots"]}
    assert (by_id[first]["ac"], by_id[first]["hp"], by_id[first]["name"]) == (16, 30, "Tough")
    assert (by_id[second]["ac"], by_id[second]["hp"]) == (16, 9)
    assert by_id[second]["snapshot"]["creature_revision"] == 2
    assert {r["outcome"] for r in body["slots"]} == {"refreshed"}
    assert body["encounter"]["revision"] == seen["revision"] + 1
    again = await owner.post(
        f"/api/ttrpg/encounters/{enc['id']}/refresh",
        json={"base_revision": body["encounter"]["revision"]},
        headers=h(owner),
    )
    assert {r["outcome"] for r in again.json()["slots"]} == {"unchanged"}
    assert again.json()["encounter"]["revision"] == body["encounter"]["revision"]


async def test_an_encounter_stays_playable_without_its_card_or_the_catalogue(
    owner: AsyncClient, campaign: dict[str, Any], srd: FakeSrd
) -> None:
    manual = (
        await owner.post(
            "/api/ttrpg/creatures", json={"name": "Orc", "ac": 13, "hp": 15}, headers=h(owner)
        )
    ).json()
    enc = await make(owner, campaign["id"])
    enc = await add_slots(owner, enc, creature_id=manual["id"], count=2)
    await owner.post(
        f"/api/ttrpg/creatures/{manual['id']}/archive",
        json={"base_revision": 1, "archived": True},
        headers=h(owner),
    )
    srd.mode = "down"
    got = (await owner.get(f"/api/ttrpg/encounters/{enc['id']}")).json()
    assert [(s["name"], s["ac"], s["hp"]) for s in got["slots"]] == [
        ("Orc 1", 13, 15),
        ("Orc 2", 13, 15),
    ]
    refresh = await owner.post(
        f"/api/ttrpg/encounters/{enc['id']}/refresh",
        json={"base_revision": got["revision"]},
        headers=h(owner),
    )
    assert {r["outcome"] for r in refresh.json()["slots"]} == {"card_archived"}
    assert refresh.json()["encounter"]["slots"] == got["slots"]  # untouched


async def test_party_selection_session_and_location_are_validated(
    owner: AsyncClient, campaign: dict[str, Any]
) -> None:
    cid = campaign["id"]
    fighter = await party_member(owner, cid)
    other = (
        await owner.post("/api/ttrpg/campaigns", json={"title": "Other"}, headers=h(owner))
    ).json()
    stranger = await party_member(owner, other["id"], "Stranger")

    async def create(**body: Any) -> Any:
        return await owner.post(
            f"/api/ttrpg/campaigns/{cid}/encounters",
            json={"title": "T", **body},
            headers=h(owner),
        )

    assert (await create(party_member_ids=[stranger["id"]])).status_code == 400
    assert (await create(party_member_ids=[str(uuid.uuid4())])).status_code == 400
    assert (await create(session_id=other["sessions"][0]["id"])).status_code == 404
    assert (await create(location_note_id=str(uuid.uuid4()))).status_code == 404
    for bad in ({"title": "  "}, {"title": "x", "extra": 1}, {"party_member_ids": [1]}):
        assert (await create(**bad)).status_code == 422
    dup = await create(party_member_ids=[fighter["id"], fighter["id"]])
    assert dup.status_code == 201 and len(dup.json()["party"]) == 1  # de-duplicated

    # a member retired later still shows, flagged; it cannot be newly selected
    await owner.post(
        f"/api/ttrpg/party/{fighter['id']}/archive",
        json={"base_revision": 1, "archived": True},
        headers=h(owner),
    )
    seen = (await owner.get(f"/api/ttrpg/encounters/{dup.json()['id']}")).json()
    assert seen["party"][0]["retired"] is True
    assert (await create(party_member_ids=[fighter["id"]])).status_code == 400

    note = (
        await owner.post(
            "/api/notes", json={"path": "Locations/Cragmaw.md", "content": "# C"}, headers=h(owner)
        )
    ).json()
    located = await create(location_note_id=note["id"])
    assert located.json()["location"]["path"] == "Locations/Cragmaw.md"
    await owner.delete(f"/api/notes/{note['id']}", headers=h(owner))
    gone = (await owner.get(f"/api/ttrpg/encounters/{located.json()['id']}")).json()
    assert gone["location"]["missing"] is True


async def test_updates_are_revision_checked_and_can_clear_optional_fields(
    owner: AsyncClient, campaign: dict[str, Any]
) -> None:
    cid = campaign["id"]
    enc = await make(owner, cid, book_reference="p. 6", session_id=campaign["sessions"][0]["id"])
    url = f"/api/ttrpg/encounters/{enc['id']}"
    ok = await owner.patch(
        url,
        json={"base_revision": 1, "title": "Ambush!", "book_reference": None, "session_id": None},
        headers=h(owner),
    )
    body = ok.json()
    assert (body["title"], body["book_reference"], body["session_id"]) == ("Ambush!", None, None)
    assert body["revision"] == 2
    stale = await owner.patch(url, json={"base_revision": 1, "title": "X"}, headers=h(owner))
    assert stale.status_code == 409
    noop = await owner.patch(url, json={"base_revision": 2, "title": "Ambush!"}, headers=h(owner))
    assert noop.json()["revision"] == 2
    gone = await owner.patch(url, json={"base_revision": 2, "archived": True}, headers=h(owner))
    assert gone.json()["archived"] is True
    listing = f"/api/ttrpg/campaigns/{cid}/encounters"
    assert (await owner.get(listing)).json()["items"] == []
    assert len((await owner.get(f"{listing}?include_archived=true")).json()["items"]) == 1


async def test_two_tabs_adding_slots_with_one_revision_let_one_win(
    owner: AsyncClient, campaign: dict[str, Any]
) -> None:
    enc = await make(owner, campaign["id"])
    body = {"base_revision": 1, "name": "Rat", "ac": 10, "hp": 1}
    results = await asyncio.gather(
        owner.post(f"/api/ttrpg/encounters/{enc['id']}/slots", json=body, headers=h(owner)),
        owner.post(f"/api/ttrpg/encounters/{enc['id']}/slots", json=body, headers=h(owner)),
    )
    assert sorted(r.status_code for r in results) == [200, 409]
    async with session_scope() as session:
        count = await session.scalar(select(func.count()).select_from(TtrpgEncounterSlot))
        assert count == 1


async def test_removing_a_slot_and_listing_by_session(
    owner: AsyncClient, campaign: dict[str, Any]
) -> None:
    cid = campaign["id"]
    sid = campaign["sessions"][0]["id"]
    one = await make(owner, cid, title="One", session_id=sid)
    await make(owner, cid, title="Two")
    one = await add_slots(owner, one, name="Rat", ac=10, hp=1, count=2)
    victim = one["slots"][0]["id"]
    removed = await owner.delete(
        f"/api/ttrpg/encounters/{one['id']}/slots/{victim}?base_revision={one['revision']}",
        headers=h(owner),
    )
    assert removed.status_code == 200 and [s["name"] for s in removed.json()["slots"]] == ["Rat 2"]
    stale = await owner.delete(
        f"/api/ttrpg/encounters/{one['id']}/slots/{victim}?base_revision=1", headers=h(owner)
    )
    assert stale.status_code == 409
    listing = (await owner.get(f"/api/ttrpg/campaigns/{cid}/encounters")).json()["items"]
    assert [(e["title"], e["slot_count"]) for e in listing] == [("One", 1), ("Two", 0)]
    by_session = (await owner.get(f"/api/ttrpg/campaigns/{cid}/encounters?session_id={sid}")).json()
    assert [e["title"] for e in by_session["items"]] == ["One"]
    assert (
        await owner.patch(
            f"/api/ttrpg/encounters/{one['id']}/slots/{uuid.uuid4()}",
            json={"base_revision": removed.json()["revision"], "hp": 3},
            headers=h(owner),
        )
    ).status_code == 404


async def test_create_is_idempotent_by_id(owner: AsyncClient, campaign: dict[str, Any]) -> None:
    eid = str(uuid.uuid4())
    url = f"/api/ttrpg/campaigns/{campaign['id']}/encounters"
    one = await owner.post(url, json={"id": eid, "title": "A"}, headers=h(owner))
    two = await owner.post(url, json={"id": eid, "title": "A"}, headers=h(owner))
    assert (one.status_code, two.status_code) == (201, 200)
    async with session_scope() as session:
        assert await session.scalar(select(func.count()).select_from(TtrpgEncounter)) == 1


async def test_the_launch_link_goes_into_the_session_note_once(
    owner: AsyncClient, campaign: dict[str, Any], notes_storage: NotesStorage
) -> None:
    cid = campaign["id"]
    session = campaign["sessions"][0]
    enc = await make(owner, cid, session_id=session["id"])
    first = await owner.post(f"/api/ttrpg/encounters/{enc['id']}/link-to-note", headers=h(owner))
    assert first.status_code == 200, first.text
    assert first.json() == {"link": enc["link"], "changed": True}
    text = notes_storage.read(session["note"]["path"]).content
    prep = text.split("## Prep", 1)[1].split("## During play", 1)[0]
    assert f"- Encounter: {enc['link']}" in prep
    again = await owner.post(f"/api/ttrpg/encounters/{enc['id']}/link-to-note", headers=h(owner))
    assert again.json()["changed"] is False
    assert notes_storage.read(session["note"]["path"]).content == text
    # the note is a normal note: its revision moved by exactly one
    note = (await owner.get(f"/api/notes/{session['note']['note_id']}")).json()
    assert note["revision"] == 2

    second = await make(owner, cid, title="Wolves", session_id=session["id"])
    await owner.post(f"/api/ttrpg/encounters/{second['id']}/link-to-note", headers=h(owner))
    prep = (
        notes_storage.read(session["note"]["path"])
        .content.split("## Prep", 1)[1]
        .split("## During play", 1)[0]
    )
    assert prep.index(enc["id"]) < prep.index(second["id"])  # appended in order


async def test_linking_needs_a_session_with_a_note(
    owner: AsyncClient, campaign: dict[str, Any]
) -> None:
    cid = campaign["id"]
    free = await make(owner, cid)
    assert (
        await owner.post(f"/api/ttrpg/encounters/{free['id']}/link-to-note", headers=h(owner))
    ).status_code == 400
    session = campaign["sessions"][0]
    attached = await make(owner, cid, session_id=session["id"])
    await owner.delete(f"/api/notes/{session['note']['note_id']}", headers=h(owner))
    missing = await owner.post(
        f"/api/ttrpg/encounters/{attached['id']}/link-to-note", headers=h(owner)
    )
    assert missing.status_code == 400 and "missing" in missing.text


async def test_an_external_edit_of_the_note_is_a_conflict_not_an_overwrite(
    owner: AsyncClient, campaign: dict[str, Any], notes_storage: NotesStorage
) -> None:
    session = campaign["sessions"][0]
    enc = await make(owner, campaign["id"], session_id=session["id"])
    path = notes_storage.absolute(session["note"]["path"])
    path.write_text(path.read_text() + "\nWritten in another editor.\n", encoding="utf-8")
    response = await owner.post(f"/api/ttrpg/encounters/{enc['id']}/link-to-note", headers=h(owner))
    assert response.status_code == 409
    assert "Written in another editor." in path.read_text()
    assert enc["id"] not in path.read_text()


def test_insert_under_prep_handles_missing_sections_fences_and_line_endings() -> None:
    bullet = "- Encounter: [x](/ttrpg/encounters/1)"
    plain = "# S\n\n## Prep\n\nNotes here.\n\n## During play\n\n"
    out = insert_under_prep(plain, bullet)
    assert out.index("Notes here.") < out.index(bullet) < out.index("## During play")
    assert insert_under_prep("# S\n\n## Prep\n\n## Next\n", bullet) == (
        "# S\n\n## Prep\n\n" + bullet + "\n\n## Next\n"
    )
    assert insert_under_prep("# S\n\n## Prep\n", bullet).endswith("## Prep\n\n" + bullet)
    no_section = insert_under_prep("# S\n\ntext\n", bullet)
    assert no_section.endswith("## Prep\n\n" + bullet + "\n") and "text" in no_section
    fenced = "# S\n\n```\n## Prep\n```\n"
    assert insert_under_prep(fenced, bullet).count("## Prep") == 2  # the real one is appended
    crlf = insert_under_prep("# S\r\n\r\n## Prep\r\n\r\nx\r\n", bullet)
    assert "\r\n" in crlf and "\n" not in crlf.replace("\r\n", "")


async def test_ownership_and_the_disabled_switch(
    app: FastAPI, owner: AsyncClient, campaign: dict[str, Any]
) -> None:
    cid = campaign["id"]
    enc = await make(owner, cid, session_id=campaign["sessions"][0]["id"])
    enc = await add_slots(owner, enc, name="Rat", ac=10, hp=1)
    eid, slot = enc["id"], enc["slots"][0]["id"]
    async with session_scope() as session:
        session.add(
            User(
                email="two@example.com",
                display_name="Two",
                password_hash=hash_password("pw pw pw pw"),
            )
        )
    other = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    try:
        await other.post(
            "/api/auth/login", json={"email": "two@example.com", "password": "pw pw pw pw"}
        )
        await other.put("/api/features/ttrpg", json={"enabled": True}, headers=h(other))
        for method, path, body in (
            ("GET", f"/api/ttrpg/campaigns/{cid}/encounters", None),
            ("POST", f"/api/ttrpg/campaigns/{cid}/encounters", {"title": "x"}),
            ("GET", f"/api/ttrpg/encounters/{eid}", None),
            ("PATCH", f"/api/ttrpg/encounters/{eid}", {"base_revision": 1, "title": "x"}),
            (
                "POST",
                f"/api/ttrpg/encounters/{eid}/slots",
                {"base_revision": 1, "name": "x", "ac": 1, "hp": 1},
            ),
            ("PATCH", f"/api/ttrpg/encounters/{eid}/slots/{slot}", {"base_revision": 2, "hp": 3}),
            ("DELETE", f"/api/ttrpg/encounters/{eid}/slots/{slot}?base_revision=2", None),
            ("POST", f"/api/ttrpg/encounters/{eid}/refresh", {"base_revision": 2}),
            ("POST", f"/api/ttrpg/encounters/{eid}/link-to-note", None),
        ):
            response = await other.request(method, path, json=body, headers=h(other))
            assert response.status_code == 404, (method, path, response.status_code)
        assert (
            await other.post(
                f"/api/ttrpg/campaigns/{cid}/encounters",
                json={"id": eid, "title": "mine"},
                headers=h(other),
            )
        ).status_code == 404  # not even a campaign of theirs
    finally:
        await other.aclose()
    await owner.put("/api/features/ttrpg", json={"enabled": False}, headers=h(owner))
    assert (await owner.get(f"/api/ttrpg/encounters/{eid}")).status_code == 404
    await owner.put("/api/features/ttrpg", json={"enabled": True}, headers=h(owner))
    assert len((await owner.get(f"/api/ttrpg/encounters/{eid}")).json()["slots"]) == 1
