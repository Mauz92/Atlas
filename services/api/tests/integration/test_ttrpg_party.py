"""Party cards, persistent play state, corrections and confirmed rests (TTRPG-03)."""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select

from atlas.auth import hash_password
from atlas.db import session_scope
from atlas.models import TtrpgPartyMember, TtrpgPartyState, User
from tests.conftest import create_user_via_setup, csrf_headers

PASSWORD = "another horse battery"

FIGHTER: dict[str, Any] = {
    "role": "pc",
    "name": "Brenna",
    "level": 3,
    "ac": 17,
    "max_hp": 28,
    "speed": 30,
    "initiative_mod": 1,
    "passive_perception": 12,
    "attacks": [{"name": "Longsword", "to_hit": 5, "damage": "1d8+3 slashing"}],
    "abilities": [{"name": "Second Wind", "text": "Bonus action: 1d10+3 HP."}],
    "resources": [
        {"key": "second-wind", "name": "Second Wind", "max": 1, "reset": "short"},
        {"key": "action-surge", "name": "Action Surge", "max": 1, "reset": "short"},
        {"key": "indomitable", "name": "Indomitable", "max": 1, "reset": "long"},
    ],
}
COMPANION: dict[str, Any] = {"role": "companion", "name": "Sildar", "ac": 15, "max_hp": 20}


def h(client: AsyncClient) -> dict[str, str]:
    return csrf_headers(client)


@pytest.fixture
async def owner(notes_client: AsyncClient) -> AsyncIterator[AsyncClient]:
    await create_user_via_setup(notes_client)
    await notes_client.put("/api/features/ttrpg", json={"enabled": True}, headers=h(notes_client))
    yield notes_client


@pytest.fixture
async def campaign(owner: AsyncClient) -> str:
    response = await owner.post(
        "/api/ttrpg/campaigns", json={"title": "Phandelver"}, headers=h(owner)
    )
    assert response.status_code == 201, response.text
    return str(response.json()["id"])


async def add(owner: AsyncClient, cid: str, card: dict[str, Any] | None = None) -> dict[str, Any]:
    response = await owner.post(
        f"/api/ttrpg/campaigns/{cid}/party", json=card or FIGHTER, headers=h(owner)
    )
    assert response.status_code in (200, 201), response.text
    data: dict[str, Any] = response.json()
    return data


async def state(owner: AsyncClient, mid: str) -> dict[str, Any]:
    data: dict[str, Any] = (await owner.get(f"/api/ttrpg/party/{mid}")).json()["state"]
    return data


async def test_a_new_member_starts_at_full_health_with_a_complete_card(
    owner: AsyncClient, campaign: str
) -> None:
    fighter = await add(owner, campaign)
    assert fighter["name"] == "Brenna" and fighter["archived"] is False
    assert fighter["attacks"][0]["name"] == "Longsword"
    assert [r["key"] for r in fighter["resources"]] == [
        "second-wind",
        "action-surge",
        "indomitable",
    ]
    assert fighter["state"] == {
        "current_hp": 28,
        "temp_hp": 0,
        "conditions": [],
        "exhaustion_level": 0,
        "death_save_successes": 0,
        "death_save_failures": 0,
        "resources_used": {},
        "revision": 1,
    }
    await add(owner, campaign, COMPANION)
    listing = (await owner.get(f"/api/ttrpg/campaigns/{campaign}/party")).json()
    assert [m["name"] for m in listing["items"]] == ["Brenna", "Sildar"]  # pc before companion
    assert "poisoned" in listing["conditions"]


async def test_creating_a_member_twice_with_one_id_is_idempotent(
    owner: AsyncClient, campaign: str
) -> None:
    mid = str(uuid.uuid4())
    one = await owner.post(
        f"/api/ttrpg/campaigns/{campaign}/party", json={**COMPANION, "id": mid}, headers=h(owner)
    )
    two = await owner.post(
        f"/api/ttrpg/campaigns/{campaign}/party", json={**COMPANION, "id": mid}, headers=h(owner)
    )
    assert (one.status_code, two.status_code) == (201, 200)
    async with session_scope() as session:
        assert await session.scalar(select(func.count()).select_from(TtrpgPartyMember)) == 1
        assert await session.scalar(select(func.count()).select_from(TtrpgPartyState)) == 1


@pytest.mark.parametrize(
    "patch",
    [
        {"name": "  "},
        {"ac": -1},
        {"ac": 41},
        {"max_hp": 0},
        {"level": 21},
        {"role": "boss"},
        {"initiative_mod": 99},
        {"unknown": 1},
        {"resources": [{"key": "A B", "name": "x", "max": 1}]},
        {"resources": [{"key": "x", "name": "x", "max": 0}]},
        {
            "resources": [
                {"key": "x", "name": "a", "max": 1},
                {"key": "x", "name": "b", "max": 1},
            ]
        },
        {"attacks": [{"name": "x", "to_hit": 99}]},
        {"attacks": [{"name": "x"}] * 21},
    ],
)
async def test_invalid_cards_are_rejected_and_nothing_is_stored(
    owner: AsyncClient, campaign: str, patch: dict[str, Any]
) -> None:
    response = await owner.post(
        f"/api/ttrpg/campaigns/{campaign}/party", json={**FIGHTER, **patch}, headers=h(owner)
    )
    assert response.status_code == 422, response.text
    assert (await owner.get(f"/api/ttrpg/campaigns/{campaign}/party")).json()["items"] == []


async def test_damage_uses_temp_hp_first_and_healing_is_capped(
    owner: AsyncClient, campaign: str
) -> None:
    mid = (await add(owner, campaign))["id"]

    async def adjust(kind: str, amount: int, revision: int) -> dict[str, Any]:
        response = await owner.post(
            f"/api/ttrpg/party/{mid}/hp",
            json={"kind": kind, "amount": amount, "base_revision": revision},
            headers=h(owner),
        )
        assert response.status_code == 200, response.text
        data: dict[str, Any] = response.json()["state"]
        return data

    s = await adjust("temp_hp", 5, 1)
    assert (s["current_hp"], s["temp_hp"], s["revision"]) == (28, 5, 2)
    s = await adjust("damage", 8, 2)
    assert (s["current_hp"], s["temp_hp"]) == (25, 0)
    s = await adjust("temp_hp", 3, 3)
    s = await adjust("temp_hp", 2, 4)
    assert s["temp_hp"] == 3  # does not stack
    s = await adjust("damage", 100, 5)
    assert (s["current_hp"], s["temp_hp"]) == (0, 0)
    s = await adjust("heal", 100, 6)
    assert s["current_hp"] == 28


async def test_concurrent_edits_with_the_same_revision_let_one_win(
    owner: AsyncClient, campaign: str
) -> None:
    mid = (await add(owner, campaign))["id"]
    body = {"kind": "damage", "amount": 5, "base_revision": 1}
    results = await asyncio.gather(
        owner.post(f"/api/ttrpg/party/{mid}/hp", json=body, headers=h(owner)),
        owner.post(f"/api/ttrpg/party/{mid}/hp", json=body, headers=h(owner)),
    )
    assert sorted(r.status_code for r in results) == [200, 409]
    loser = next(r for r in results if r.status_code == 409)
    assert loser.json()["detail"]["current_revision"] == 2
    final = await state(owner, mid)
    assert final["current_hp"] == 23 and final["revision"] == 2  # applied exactly once


async def test_a_stale_client_cannot_overwrite_newer_state(
    owner: AsyncClient, campaign: str
) -> None:
    mid = (await add(owner, campaign))["id"]
    ok = await owner.patch(
        f"/api/ttrpg/party/{mid}/state",
        json={"base_revision": 1, "conditions": ["prone"]},
        headers=h(owner),
    )
    assert ok.status_code == 200
    stale = await owner.patch(
        f"/api/ttrpg/party/{mid}/state",
        json={"base_revision": 1, "conditions": []},
        headers=h(owner),
    )
    assert stale.status_code == 409
    assert (await state(owner, mid))["conditions"] == ["prone"]


async def test_manual_corrections_conditions_death_saves_and_resources(
    owner: AsyncClient, campaign: str
) -> None:
    mid = (await add(owner, campaign))["id"]

    async def patch(revision: int, **fields: Any) -> Any:
        return await owner.patch(
            f"/api/ttrpg/party/{mid}/state",
            json={"base_revision": revision, **fields},
            headers=h(owner),
        )

    r = await patch(
        1,
        current_hp=0,
        conditions=["unconscious", "prone", "prone"],
        death_save_failures=2,
        death_save_successes=1,
        exhaustion_level=1,
        resources_used={"second-wind": 1},
    )
    assert r.status_code == 200, r.text
    s = r.json()["state"]
    assert s["conditions"] == ["prone", "unconscious"]  # de-duplicated, ordered
    assert (s["death_save_failures"], s["death_save_successes"]) == (2, 1)
    assert s["resources_used"] == {"second-wind": 1} and s["exhaustion_level"] == 1

    # refused, with no partial change
    for revision, fields in (
        (2, {"conditions": ["sleepy"]}),
        (2, {"current_hp": 29}),
        (2, {"resources_used": {"nonsense": 1}}),
        (2, {"resources_used": {"second-wind": 2}}),
        (2, {"temp_hp": -1}),
        (2, {"death_save_failures": 4}),
    ):
        bad = await patch(revision, **fields)
        assert bad.status_code in (400, 422), (fields, bad.text)
    assert (await state(owner, mid))["revision"] == 2

    # healing above zero clears the death saves; marks make no sense above zero
    healed = await patch(2, current_hp=5)
    assert healed.json()["state"]["death_save_failures"] == 0
    marks = await patch(3, death_save_failures=1)
    assert marks.status_code == 400


async def test_editing_the_card_clamps_state_without_resetting_it(
    owner: AsyncClient, campaign: str
) -> None:
    fighter = await add(owner, campaign)
    mid = fighter["id"]
    used = await owner.patch(
        f"/api/ttrpg/party/{mid}/state",
        json={"base_revision": 1, "resources_used": {"indomitable": 1, "action-surge": 1}},
        headers=h(owner),
    )
    assert used.status_code == 200
    card = {
        k: v
        for k, v in fighter.items()
        if k not in ("id", "campaign_id", "archived", "state", "revision")
    }
    card["max_hp"] = 10
    card["resources"] = [r for r in card["resources"] if r["key"] != "indomitable"]
    card["base_revision"] = fighter["revision"]
    updated = await owner.put(f"/api/ttrpg/party/{mid}", json=card, headers=h(owner))
    assert updated.status_code == 200, updated.text
    body = updated.json()
    assert body["revision"] == 2 and body["max_hp"] == 10
    assert body["state"]["current_hp"] == 10  # clamped to the new maximum
    assert body["state"]["resources_used"] == {"action-surge": 1}  # removed resource dropped
    stale = await owner.put(f"/api/ttrpg/party/{mid}", json=card, headers=h(owner))
    assert stale.status_code == 409
    # saving an identical card changes nothing, not even the revision
    card["base_revision"] = 2
    same = await owner.put(f"/api/ttrpg/party/{mid}", json=card, headers=h(owner))
    assert same.json()["revision"] == 2


async def test_archived_members_leave_the_roster_but_keep_their_record(
    owner: AsyncClient, campaign: str
) -> None:
    fighter = await add(owner, campaign)
    mid = fighter["id"]
    gone = await owner.post(
        f"/api/ttrpg/party/{mid}/archive",
        json={"base_revision": 1, "archived": True},
        headers=h(owner),
    )
    assert gone.json()["archived"] is True
    base = f"/api/ttrpg/campaigns/{campaign}/party"
    assert (await owner.get(base)).json()["items"] == []
    assert len((await owner.get(f"{base}?include_archived=true")).json()["items"]) == 1
    assert (await owner.get(f"/api/ttrpg/party/{mid}")).status_code == 200  # still resolves
    preview = (
        await owner.post(
            f"/api/ttrpg/campaigns/{campaign}/rest/preview", json={"kind": "long"}, headers=h(owner)
        )
    ).json()
    assert preview["members"] == []  # a retired member is not rested


async def _hurt_fighter(owner: AsyncClient, mid: str) -> None:
    r = await owner.patch(
        f"/api/ttrpg/party/{mid}/state",
        json={
            "base_revision": 1,
            "current_hp": 9,
            "temp_hp": 4,
            "exhaustion_level": 2,
            "resources_used": {"second-wind": 1, "indomitable": 1},
            "conditions": ["poisoned"],
        },
        headers=h(owner),
    )
    assert r.status_code == 200, r.text


async def test_rest_preview_changes_nothing_and_confirmed_rest_applies_with_overrides(
    owner: AsyncClient, campaign: str
) -> None:
    fighter = await add(owner, campaign)
    sildar = await add(owner, campaign, COMPANION)
    mid, sid = fighter["id"], sildar["id"]
    await _hurt_fighter(owner, mid)

    url = f"/api/ttrpg/campaigns/{campaign}"
    short = (
        await owner.post(f"{url}/rest/preview", json={"kind": "short"}, headers=h(owner))
    ).json()
    assert short["notes"]  # hit dice are not tracked
    brenna = next(m for m in short["members"] if m["member_id"] == mid)
    assert brenna["resources_used"] == {"second-wind": {"before": 1, "after": 0}}
    assert brenna["hp"] is None
    assert next(m for m in short["members"] if m["member_id"] == sid)["unchanged"] is True
    assert (await state(owner, mid))["resources_used"] == {"second-wind": 1, "indomitable": 1}

    long = (await owner.post(f"{url}/rest/preview", json={"kind": "long"}, headers=h(owner))).json()
    brenna = next(m for m in long["members"] if m["member_id"] == mid)
    assert brenna["hp"] == {"before": 9, "after": 28}
    assert brenna["temp_hp"] == {"before": 4, "after": 0}
    assert brenna["exhaustion_level"] == {"before": 2, "after": 1}
    assert brenna["state_revision"] == 2

    # confirm, but the DM keeps one use of Indomitable spent and sets HP by hand
    applied = await owner.post(
        f"{url}/rest",
        json={
            "kind": "long",
            "members": [
                {
                    "member_id": mid,
                    "base_revision": 2,
                    "overrides": {"current_hp": 25, "resources_used": {"indomitable": 1}},
                }
            ],
        },
        headers=h(owner),
    )
    assert applied.status_code == 200, applied.text
    after = next(m for m in applied.json()["items"] if m["id"] == mid)["state"]
    assert after["current_hp"] == 25 and after["temp_hp"] == 0
    assert after["exhaustion_level"] == 1
    assert after["resources_used"] == {"indomitable": 1}
    assert after["conditions"] == ["poisoned"]  # a rest does not cure conditions
    assert after["revision"] == 3


async def test_a_rest_with_one_stale_member_changes_nobody(
    owner: AsyncClient, campaign: str
) -> None:
    fighter = await add(owner, campaign)
    sildar = await add(owner, campaign, COMPANION)
    await _hurt_fighter(owner, fighter["id"])
    await owner.patch(
        f"/api/ttrpg/party/{sildar['id']}/state",
        json={"base_revision": 1, "current_hp": 3},
        headers=h(owner),
    )
    response = await owner.post(
        f"/api/ttrpg/campaigns/{campaign}/rest",
        json={
            "kind": "long",
            "members": [
                {"member_id": fighter["id"], "base_revision": 2},
                {"member_id": sildar["id"], "base_revision": 1},  # stale
            ],
        },
        headers=h(owner),
    )
    assert response.status_code == 409
    assert (await state(owner, fighter["id"]))["current_hp"] == 9  # untouched
    assert (await state(owner, sildar["id"]))["current_hp"] == 3
    dup = await owner.post(
        f"/api/ttrpg/campaigns/{campaign}/rest",
        json={
            "kind": "long",
            "members": [
                {"member_id": fighter["id"], "base_revision": 2},
                {"member_id": fighter["id"], "base_revision": 2},
            ],
        },
        headers=h(owner),
    )
    assert dup.status_code == 400


async def test_a_member_of_another_campaign_cannot_be_rested_here(
    owner: AsyncClient, campaign: str
) -> None:
    other = (
        await owner.post("/api/ttrpg/campaigns", json={"title": "Other"}, headers=h(owner))
    ).json()["id"]
    stranger = await add(owner, other)
    response = await owner.post(
        f"/api/ttrpg/campaigns/{campaign}/rest",
        json={"kind": "long", "members": [{"member_id": stranger["id"], "base_revision": 1}]},
        headers=h(owner),
    )
    assert response.status_code == 404


async def test_ownership_and_the_disabled_switch(
    app: FastAPI, owner: AsyncClient, campaign: str
) -> None:
    fighter = await add(owner, campaign)
    mid = fighter["id"]
    async with session_scope() as session:
        session.add(
            User(email="two@example.com", display_name="Two", password_hash=hash_password(PASSWORD))
        )
    other = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    try:
        await other.post("/api/auth/login", json={"email": "two@example.com", "password": PASSWORD})
        await other.put("/api/features/ttrpg", json={"enabled": True}, headers=h(other))
        for method, path, body in (
            ("GET", f"/api/ttrpg/campaigns/{campaign}/party", None),
            ("POST", f"/api/ttrpg/campaigns/{campaign}/party", FIGHTER),
            ("GET", f"/api/ttrpg/party/{mid}", None),
            ("PUT", f"/api/ttrpg/party/{mid}", {**FIGHTER, "base_revision": 1}),
            ("POST", f"/api/ttrpg/party/{mid}/archive", {"base_revision": 1, "archived": True}),
            ("PATCH", f"/api/ttrpg/party/{mid}/state", {"base_revision": 1, "temp_hp": 1}),
            (
                "POST",
                f"/api/ttrpg/party/{mid}/hp",
                {"base_revision": 1, "kind": "heal", "amount": 1},
            ),
            ("POST", f"/api/ttrpg/campaigns/{campaign}/rest/preview", {"kind": "long"}),
            ("POST", f"/api/ttrpg/campaigns/{campaign}/rest", {"kind": "long", "members": []}),
        ):
            response = await other.request(method, path, json=body, headers=h(other))
            assert response.status_code == 404, (method, path, response.status_code)
        # a foreign member id cannot be claimed through a create either
        taken = await other.post("/api/ttrpg/campaigns", json={"title": "Theirs"}, headers=h(other))
        stolen = await other.post(
            f"/api/ttrpg/campaigns/{taken.json()['id']}/party",
            json={**FIGHTER, "id": mid},
            headers=h(other),
        )
        assert stolen.status_code == 409
    finally:
        await other.aclose()
    await owner.put("/api/features/ttrpg", json={"enabled": False}, headers=h(owner))
    assert (await owner.get(f"/api/ttrpg/party/{mid}")).status_code == 404
    await owner.put("/api/features/ttrpg", json={"enabled": True}, headers=h(owner))
    assert (await state(owner, mid))["current_hp"] == 28  # kept while disabled


async def test_party_state_survives_in_the_database_between_fights(
    owner: AsyncClient, campaign: str
) -> None:
    mid = (await add(owner, campaign))["id"]
    await owner.post(
        f"/api/ttrpg/party/{mid}/hp",
        json={"kind": "damage", "amount": 11, "base_revision": 1},
        headers=h(owner),
    )
    async with session_scope() as session:
        row = await session.get(TtrpgPartyState, uuid.UUID(mid))
        assert row is not None and row.current_hp == 17
