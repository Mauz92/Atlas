"""Creature cards, SRD import and provenance (TTRPG-04). The catalogue is a fake: no network."""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select

from atlas.api.ttrpg import get_srd_catalog
from atlas.auth import hash_password
from atlas.db import session_scope
from atlas.models import TtrpgCreature, User
from atlas.ttrpg.srd import ATTRIBUTION, HttpSrdCatalog
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


async def count_cards() -> int:
    async with session_scope() as session:
        return int(await session.scalar(select(func.count()).select_from(TtrpgCreature)) or 0)


async def test_a_manual_card_needs_only_name_ac_and_hp(owner: AsyncClient) -> None:
    created = await owner.post(
        "/api/ttrpg/creatures",
        json={"name": "Bandit Captain", "ac": 15, "hp": 65},
        headers=h(owner),
    )
    assert created.status_code == 201, created.text
    card = created.json()
    assert (card["source"], card["external_id"], card["attribution"]) == ("manual", None, None)
    assert card["traits"] == [] and card["actions"] == [] and card["revision"] == 1


async def test_manual_cards_are_idempotent_validated_and_editable(owner: AsyncClient) -> None:
    cid = str(uuid.uuid4())
    body = {"id": cid, "name": "Orc", "ac": 13, "hp": 15, "actions": [{"name": "Greataxe"}]}
    one = await owner.post("/api/ttrpg/creatures", json=body, headers=h(owner))
    two = await owner.post("/api/ttrpg/creatures", json=body, headers=h(owner))
    assert (one.status_code, two.status_code) == (201, 200)
    assert await count_cards() == 1
    for bad in (
        {"name": " ", "ac": 1, "hp": 1},
        {"name": "x", "ac": -1, "hp": 1},
        {"name": "x", "ac": 1, "hp": 0},
        {"name": "x", "ac": 1, "hp": 1, "extra": 1},
        {"name": "x", "ac": 1, "hp": 1, "actions": [{"name": "a", "kind": "bonus"}]},
    ):
        assert (
            await owner.post("/api/ttrpg/creatures", json=bad, headers=h(owner))
        ).status_code == 422
    update = {"name": "Orc", "ac": 14, "hp": 15, "base_revision": 1}
    ok = await owner.put(f"/api/ttrpg/creatures/{cid}", json=update, headers=h(owner))
    assert ok.status_code == 200 and ok.json()["revision"] == 2 and ok.json()["ac"] == 14
    stale = await owner.put(f"/api/ttrpg/creatures/{cid}", json=update, headers=h(owner))
    assert stale.status_code == 409
    same = await owner.put(
        f"/api/ttrpg/creatures/{cid}", json={**update, "base_revision": 2}, headers=h(owner)
    )
    assert same.json()["revision"] == 2  # an unchanged save is not a new revision


async def test_search_finds_local_cards_and_escapes_wildcards(owner: AsyncClient) -> None:
    for name in ("Orc", "Orc Chief", "100% Real"):
        await owner.post(
            "/api/ttrpg/creatures", json={"name": name, "ac": 10, "hp": 5}, headers=h(owner)
        )
    names = lambda r: [c["name"] for c in r.json()["items"]]  # noqa: E731
    assert names(await owner.get("/api/ttrpg/creatures?q=orc")) == ["Orc", "Orc Chief"]
    assert names(await owner.get("/api/ttrpg/creatures?q=%25")) == ["100% Real"]
    assert names(await owner.get("/api/ttrpg/creatures?q=_")) == []


async def test_importing_an_srd_creature_keeps_provenance_and_attribution(
    owner: AsyncClient, srd: FakeSrd
) -> None:
    search = (await owner.get("/api/ttrpg/srd/monsters?q=gob")).json()
    assert [e["index"] for e in search["items"]] == ["goblin", "goblin-boss"]
    assert search["attribution"] == ATTRIBUTION
    assert all(e["imported_as"] is None for e in search["items"])

    imported = await owner.post("/api/ttrpg/srd/import", json={"index": "goblin"}, headers=h(owner))
    assert imported.status_code == 201, imported.text
    card = imported.json()
    assert (card["source"], card["source_edition"], card["external_id"]) == (
        "srd",
        "2014",
        "goblin",
    )
    assert card["attribution"] == ATTRIBUTION and card["imported_at"]
    assert (card["name"], card["ac"], card["hp"], card["initiative_mod"]) == ("Goblin", 15, 7, 2)
    assert card["challenge_rating"] == "1/4"
    assert card["actions"][0] == {
        "name": "Scimitar",
        "text": "Melee Weapon Attack: +4 to hit.",
        "kind": "action",
        "to_hit": 4,
        "damage": "1d6+2 Slashing",
    }
    after = (await owner.get("/api/ttrpg/srd/monsters?q=goblin")).json()["items"]
    assert after[0]["imported_as"] == card["id"]


async def test_a_repeat_import_is_idempotent_and_does_not_call_the_catalogue(
    owner: AsyncClient, srd: FakeSrd
) -> None:
    first = await owner.post("/api/ttrpg/srd/import", json={"index": "wolf"}, headers=h(owner))
    calls = len(srd.requests)
    again = await owner.post("/api/ttrpg/srd/import", json={"index": "wolf"}, headers=h(owner))
    assert (first.status_code, again.status_code) == (201, 200)
    assert again.json()["id"] == first.json()["id"] and await count_cards() == 1
    assert len(srd.requests) == calls  # served from the local card


async def test_concurrent_imports_make_one_card(owner: AsyncClient) -> None:
    results = await asyncio.gather(
        *(
            owner.post("/api/ttrpg/srd/import", json={"index": "goblin"}, headers=h(owner))
            for _ in range(3)
        )
    )
    assert {r.status_code for r in results} <= {200, 201}
    assert len({r.json()["id"] for r in results}) == 1
    assert await count_cards() == 1


@pytest.mark.parametrize("mode", ["down", "timeout", "garbage", "huge", "redirect"])
async def test_catalogue_failures_are_clean_and_leave_manual_cards_working(
    owner: AsyncClient, srd: FakeSrd, mode: str
) -> None:
    srd.mode = mode
    failed = await owner.post("/api/ttrpg/srd/import", json={"index": "goblin"}, headers=h(owner))
    assert failed.status_code == 502, failed.text
    for leak in ("srd.example", "maintenance", "evil.example", "html"):
        assert leak not in failed.text
    assert (await owner.get("/api/ttrpg/srd/monsters?q=gob")).status_code == 502
    assert await count_cards() == 0
    manual = await owner.post(
        "/api/ttrpg/creatures", json={"name": "Homebrew", "ac": 12, "hp": 9}, headers=h(owner)
    )
    assert manual.status_code == 201


async def test_malformed_payload_imports_nothing(owner: AsyncClient, srd: FakeSrd) -> None:
    srd.monsters["goblin"] = {**GOBLIN, "hit_points": "lots"}
    response = await owner.post("/api/ttrpg/srd/import", json={"index": "goblin"}, headers=h(owner))
    assert response.status_code == 502 and await count_cards() == 0


async def test_unknown_and_malformed_indexes(owner: AsyncClient) -> None:
    missing = await owner.post(
        "/api/ttrpg/srd/import", json={"index": "tarrasque"}, headers=h(owner)
    )
    assert missing.status_code == 404
    for index in ("../x", "A B", "", "x" * 101):
        bad = await owner.post("/api/ttrpg/srd/import", json={"index": index}, headers=h(owner))
        assert bad.status_code == 422


async def test_imported_cards_are_read_only_and_variants_are_editable(
    owner: AsyncClient,
) -> None:
    card = (
        await owner.post("/api/ttrpg/srd/import", json={"index": "goblin"}, headers=h(owner))
    ).json()
    edit = {k: card[k] for k in ("name", "ac", "hp")} | {"base_revision": 1}
    refused = await owner.put(f"/api/ttrpg/creatures/{card['id']}", json=edit, headers=h(owner))
    assert refused.status_code == 400 and "duplicate" in refused.text

    vid = str(uuid.uuid4())
    one = await owner.post(
        f"/api/ttrpg/creatures/{card['id']}/duplicate", json={"id": vid}, headers=h(owner)
    )
    two = await owner.post(
        f"/api/ttrpg/creatures/{card['id']}/duplicate", json={"id": vid}, headers=h(owner)
    )
    assert (one.status_code, two.status_code) == (201, 200)
    variant = one.json()
    assert variant["source"] == "manual" and variant["derived_from_id"] == card["id"]
    assert variant["attribution"] == ATTRIBUTION  # derived SRD material keeps its notice
    assert variant["name"] == "Goblin (variant)" and variant["external_id"] is None
    tuned = await owner.put(
        f"/api/ttrpg/creatures/{vid}",
        json={"name": "Goblin Warband Leader", "ac": 16, "hp": 21, "base_revision": 1},
        headers=h(owner),
    )
    assert tuned.status_code == 200 and tuned.json()["hp"] == 21
    unchanged = (await owner.get(f"/api/ttrpg/creatures/{card['id']}")).json()
    assert unchanged["hp"] == 7  # the source card is untouched


async def test_upstream_changes_reach_a_card_only_through_an_explicit_refresh(
    owner: AsyncClient, srd: FakeSrd
) -> None:
    card = (
        await owner.post("/api/ttrpg/srd/import", json={"index": "goblin"}, headers=h(owner))
    ).json()
    srd.monsters["goblin"] = {**GOBLIN, "hit_points": 9}  # upstream edit
    assert (await owner.get(f"/api/ttrpg/creatures/{card['id']}")).json()["hp"] == 7
    assert (
        await owner.post("/api/ttrpg/srd/import", json={"index": "goblin"}, headers=h(owner))
    ).json()["hp"] == 7  # re-importing does not refresh either

    refreshed = await owner.post(
        f"/api/ttrpg/creatures/{card['id']}/refresh", json={"base_revision": 1}, headers=h(owner)
    )
    assert refreshed.status_code == 200, refreshed.text
    assert refreshed.json()["hp"] == 9 and refreshed.json()["revision"] == 2
    again = await owner.post(
        f"/api/ttrpg/creatures/{card['id']}/refresh", json={"base_revision": 2}, headers=h(owner)
    )
    assert again.json()["revision"] == 2  # nothing changed, nothing bumped
    stale = await owner.post(
        f"/api/ttrpg/creatures/{card['id']}/refresh", json={"base_revision": 1}, headers=h(owner)
    )
    assert stale.status_code == 409
    srd.mode = "down"
    down = await owner.post(
        f"/api/ttrpg/creatures/{card['id']}/refresh", json={"base_revision": 2}, headers=h(owner)
    )
    assert down.status_code == 502
    assert (await owner.get(f"/api/ttrpg/creatures/{card['id']}")).json()["hp"] == 9  # kept
    manual = (
        await owner.post(
            "/api/ttrpg/creatures", json={"name": "M", "ac": 1, "hp": 1}, headers=h(owner)
        )
    ).json()
    not_srd = await owner.post(
        f"/api/ttrpg/creatures/{manual['id']}/refresh", json={"base_revision": 1}, headers=h(owner)
    )
    assert not_srd.status_code == 400


async def test_archiving_hides_a_card_but_keeps_it_resolvable(owner: AsyncClient) -> None:
    card = (
        await owner.post(
            "/api/ttrpg/creatures", json={"name": "Old", "ac": 10, "hp": 4}, headers=h(owner)
        )
    ).json()
    gone = await owner.post(
        f"/api/ttrpg/creatures/{card['id']}/archive",
        json={"base_revision": 1, "archived": True},
        headers=h(owner),
    )
    assert gone.json()["archived"] is True
    assert (await owner.get("/api/ttrpg/creatures")).json()["items"] == []
    assert len((await owner.get("/api/ttrpg/creatures?include_archived=true")).json()["items"]) == 1
    assert (await owner.get(f"/api/ttrpg/creatures/{card['id']}")).status_code == 200


async def test_the_catalogue_can_be_switched_off(
    app: FastAPI, owner: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    app.dependency_overrides.pop(get_srd_catalog, None)
    from atlas.config import get_settings

    monkeypatch.setattr(get_settings(), "ttrpg_srd_enabled", False)
    for method, path, body in (
        ("GET", "/api/ttrpg/srd/monsters?q=x", None),
        ("POST", "/api/ttrpg/srd/import", {"index": "goblin"}),
    ):
        response = await owner.request(method, path, json=body, headers=h(owner))
        assert response.status_code == 404 and "turned off" in response.text
    manual = await owner.post(
        "/api/ttrpg/creatures", json={"name": "M", "ac": 1, "hp": 1}, headers=h(owner)
    )
    assert manual.status_code == 201


async def test_ownership_and_the_disabled_switch(app: FastAPI, owner: AsyncClient) -> None:
    card = (
        await owner.post("/api/ttrpg/srd/import", json={"index": "goblin"}, headers=h(owner))
    ).json()
    cid = card["id"]
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
        assert (await other.get("/api/ttrpg/creatures")).json()["items"] == []
        for method, path, body in (
            ("GET", f"/api/ttrpg/creatures/{cid}", None),
            (
                "PUT",
                f"/api/ttrpg/creatures/{cid}",
                {"name": "x", "ac": 1, "hp": 1, "base_revision": 1},
            ),
            ("POST", f"/api/ttrpg/creatures/{cid}/duplicate", {}),
            ("POST", f"/api/ttrpg/creatures/{cid}/archive", {"base_revision": 1, "archived": True}),
            ("POST", f"/api/ttrpg/creatures/{cid}/refresh", {"base_revision": 1}),
        ):
            response = await other.request(method, path, json=body, headers=h(other))
            assert response.status_code == 404, (method, path)
        # each owner has their own import of the same creature
        mine = await other.post("/api/ttrpg/srd/import", json={"index": "goblin"}, headers=h(other))
        assert mine.status_code == 201 and mine.json()["id"] != cid
        assert (
            await other.post(
                "/api/ttrpg/creatures",
                json={"id": cid, "name": "x", "ac": 1, "hp": 1},
                headers=h(other),
            )
        ).status_code == 409
    finally:
        await other.aclose()
    await owner.put("/api/features/ttrpg", json={"enabled": False}, headers=h(owner))
    for path in ("/api/ttrpg/creatures", "/api/ttrpg/srd/monsters?q=x"):
        assert (await owner.get(path)).status_code == 404
    await owner.put("/api/features/ttrpg", json={"enabled": True}, headers=h(owner))
    assert (await owner.get(f"/api/ttrpg/creatures/{cid}")).json()["name"] == "Goblin"


async def test_text_from_the_catalogue_is_returned_as_inert_strings(
    owner: AsyncClient, srd: FakeSrd
) -> None:
    srd.monsters["goblin"] = {
        **GOBLIN,
        "special_abilities": [
            {"name": "<img src=x onerror=alert(1)>", "desc": "<script>x</script>"}
        ],
    }
    card = (
        await owner.post("/api/ttrpg/srd/import", json={"index": "goblin"}, headers=h(owner))
    ).json()
    assert card["traits"][0]["text"] == "<script>x</script>"  # stored verbatim as text
    assert (
        (await owner.get(f"/api/ttrpg/creatures/{card['id']}"))
        .headers["content-type"]
        .startswith("application/json")
    )
