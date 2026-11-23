"""Combat runs: initiative, turns, actions, undo, pause/resume and carry-over (TTRPG-06)."""

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
from atlas.models import TtrpgCombatAction, TtrpgCombatant, TtrpgCombatRun, TtrpgPartyState, User
from tests.conftest import create_user_via_setup, csrf_headers

RES = [{"key": "second-wind", "name": "Second Wind", "max": 1, "reset": "short"}]


def h(client: AsyncClient) -> dict[str, str]:
    return csrf_headers(client)


def key() -> str:
    return uuid.uuid4().hex


@pytest.fixture
async def owner(notes_client: AsyncClient) -> AsyncIterator[AsyncClient]:
    await create_user_via_setup(notes_client)
    await notes_client.put("/api/features/ttrpg", json={"enabled": True}, headers=h(notes_client))
    yield notes_client


class Table:
    """A campaign with two party members and a prepared ambush of three goblins."""

    def __init__(self, owner: AsyncClient) -> None:
        self.c = owner
        self.campaign: dict[str, Any] = {}
        self.brenna: dict[str, Any] = {}
        self.sildar: dict[str, Any] = {}
        self.encounter: dict[str, Any] = {}

    async def build(self, goblins: int = 3, title: str = "Phandelver") -> Table:
        c = self.c
        self.campaign = (
            await c.post("/api/ttrpg/campaigns", json={"title": title}, headers=h(c))
        ).json()
        cid = self.campaign["id"]
        self.brenna = (
            await c.post(
                f"/api/ttrpg/campaigns/{cid}/party",
                json={
                    "name": "Brenna",
                    "ac": 17,
                    "max_hp": 28,
                    "initiative_mod": 1,
                    "resources": RES,
                },
                headers=h(c),
            )
        ).json()
        self.sildar = (
            await c.post(
                f"/api/ttrpg/campaigns/{cid}/party",
                json={"role": "companion", "name": "Sildar", "ac": 15, "max_hp": 20},
                headers=h(c),
            )
        ).json()
        card = (
            await c.post(
                "/api/ttrpg/creatures",
                json={"name": "Goblin", "ac": 15, "hp": 7, "initiative_mod": 2},
                headers=h(c),
            )
        ).json()
        enc = (
            await c.post(
                f"/api/ttrpg/campaigns/{cid}/encounters",
                json={
                    "title": "Goblin ambush",
                    "book_reference": "p. 6",
                    "setup_reminder": "Hide two goblins.",
                    "session_id": self.campaign["sessions"][0]["id"],
                    "party_member_ids": [self.brenna["id"], self.sildar["id"]],
                },
                headers=h(c),
            )
        ).json()
        self.encounter = (
            await c.post(
                f"/api/ttrpg/encounters/{enc['id']}/slots",
                json={"base_revision": 1, "creature_id": card["id"], "count": goblins},
                headers=h(c),
            )
        ).json()
        return self

    async def launch(self, **body: Any) -> dict[str, Any]:
        body.setdefault("encounter_id", self.encounter["id"])
        response = await self.c.post(
            f"/api/ttrpg/campaigns/{self.campaign['id']}/runs", json=body, headers=h(self.c)
        )
        assert response.status_code in (200, 201), response.text
        data: dict[str, Any] = response.json()
        return data

    async def started(
        self, totals: dict[str, int] | None = None, tie_order: list[str] | None = None
    ) -> dict[str, Any]:
        """Launch and start; default totals: Brenna 18, Sildar 12, goblins 15, 10, 5."""
        run = await self.launch()
        names = {c["name"]: c["id"] for c in run["combatants"]}
        values = totals or {
            "Brenna": 18,
            "Sildar": 12,
            "Goblin 1": 15,
            "Goblin 2": 10,
            "Goblin 3": 5,
        }
        run = await self.setup(run, {names[n]: v for n, v in values.items()})
        return await self.start(run, tie_order)

    async def setup(self, run: dict[str, Any], initiative: dict[str, int]) -> dict[str, Any]:
        response = await self.c.patch(
            f"/api/ttrpg/runs/{run['id']}/setup",
            json={"base_revision": run["revision"], "initiative": initiative},
            headers=h(self.c),
        )
        assert response.status_code == 200, response.text
        data: dict[str, Any] = response.json()
        return data

    async def start(
        self, run: dict[str, Any], tie_order: list[str] | None = None
    ) -> dict[str, Any]:
        response = await self.c.post(
            f"/api/ttrpg/runs/{run['id']}/start",
            json={"base_revision": run["revision"], "tie_order": tie_order},
            headers=h(self.c),
        )
        assert response.status_code == 200, response.text
        data: dict[str, Any] = response.json()
        return data

    async def raw(self, run: dict[str, Any], kind: str, **fields: Any) -> Any:
        """One action; fills in the run revision, a fresh key and the party revision."""
        body: dict[str, Any] = {
            "kind": kind,
            "mutation_key": fields.pop("mutation_key", key()),
            "base_revision": fields.pop("base_revision", run["revision"]),
        }
        combatant = fields.get("combatant_id")
        if combatant and "party_revisions" not in fields:
            row = next((c for c in run["combatants"] if c["id"] == combatant), None)
            if row is not None and row["party_revision"] is not None:
                fields["party_revisions"] = {row["party_member_id"]: row["party_revision"]}
        body.update(fields)
        return await self.c.post(
            f"/api/ttrpg/runs/{run['id']}/actions", json=body, headers=h(self.c)
        )

    async def act(self, run: dict[str, Any], kind: str, **fields: Any) -> dict[str, Any]:
        response = await self.raw(run, kind, **fields)
        assert response.status_code == 200, response.text
        data: dict[str, Any] = response.json()["run"]
        return data

    async def undo(self, run: dict[str, Any], **kw: Any) -> Any:
        return await self.c.post(
            f"/api/ttrpg/runs/{run['id']}/undo",
            json={"mutation_key": kw.get("mutation_key", key()), "base_revision": run["revision"]},
            headers=h(self.c),
        )

    async def get(self, run: dict[str, Any]) -> dict[str, Any]:
        data: dict[str, Any] = (await self.c.get(f"/api/ttrpg/runs/{run['id']}")).json()
        return data


def by_name(run: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {c["name"]: c for c in run["combatants"]}


def order(run: dict[str, Any]) -> list[str]:
    return [
        c["name"] for c in run["combatants"] if c["order_index"] is not None and not c["removed"]
    ]


@pytest.fixture
async def table(owner: AsyncClient) -> Table:
    return await Table(owner).build()


async def test_launching_an_encounter_builds_the_roster(table: Table) -> None:
    run = await table.launch()
    assert (run["status"], run["round"], run["revision"]) == ("setup", 0, 1)
    assert (run["title"], run["book_reference"], run["setup_reminder"]) == (
        "Goblin ambush",
        "p. 6",
        "Hide two goblins.",
    )
    rows = by_name(run)
    assert sorted(rows) == ["Brenna", "Goblin 1", "Goblin 2", "Goblin 3", "Sildar"]
    assert (rows["Brenna"]["kind"], rows["Brenna"]["hp"], rows["Brenna"]["max_hp"]) == (
        "party",
        28,
        28,
    )
    assert rows["Brenna"]["party_revision"] == 1 and rows["Brenna"]["resources"][0]["used"] == 0
    assert (rows["Goblin 1"]["kind"], rows["Goblin 1"]["hp"], rows["Goblin 1"]["ac"]) == (
        "npc",
        7,
        15,
    )
    assert rows["Goblin 1"]["party_revision"] is None
    assert all(c["initiative"] is None and c["order_index"] is None for c in run["combatants"])
    # a retry with the same id returns the same run; a second fight is refused
    rid = str(uuid.uuid4())
    cid = table.campaign["id"]
    other = (
        await table.c.post("/api/ttrpg/campaigns", json={"title": "B"}, headers=h(table.c))
    ).json()
    first = await table.c.post(
        f"/api/ttrpg/campaigns/{other['id']}/runs", json={"id": rid}, headers=h(table.c)
    )
    again = await table.c.post(
        f"/api/ttrpg/campaigns/{other['id']}/runs", json={"id": rid}, headers=h(table.c)
    )
    assert (first.status_code, again.status_code) == (201, 200)
    blocked = await table.c.post(f"/api/ttrpg/campaigns/{cid}/runs", json={}, headers=h(table.c))
    assert blocked.status_code == 409
    assert blocked.json()["detail"]["run_id"] == run["id"]


async def test_each_goblin_has_its_own_hit_points(table: Table) -> None:
    run = await table.started()
    names = by_name(run)
    run = await table.act(run, "damage", combatant_id=names["Goblin 1"]["id"], amount=4)
    run = await table.act(run, "damage", combatant_id=names["Goblin 2"]["id"], amount=7)
    rows = by_name(run)
    assert (rows["Goblin 1"]["hp"], rows["Goblin 2"]["hp"], rows["Goblin 3"]["hp"]) == (3, 0, 7)
    assert rows["Goblin 2"]["defeated"] is True and rows["Goblin 1"]["defeated"] is False
    run = await table.act(run, "heal", combatant_id=names["Goblin 2"]["id"], amount=2)
    assert by_name(run)["Goblin 2"]["hp"] == 2 and by_name(run)["Goblin 2"]["defeated"] is False
    run = await table.act(run, "temp_hp", combatant_id=names["Goblin 3"]["id"], amount=5)
    run = await table.act(run, "damage", combatant_id=names["Goblin 3"]["id"], amount=6)
    assert (by_name(run)["Goblin 3"]["hp"], by_name(run)["Goblin 3"]["temp_hp"]) == (6, 0)
    run = await table.act(run, "set_hp", combatant_id=names["Goblin 3"]["id"], hp=7)
    over = await table.raw(run, "set_hp", combatant_id=names["Goblin 3"]["id"], hp=8)
    assert over.status_code == 400


async def test_initiative_accepts_zero_and_negative_totals_and_sorts(table: Table) -> None:
    run = await table.launch()
    ids = {c["name"]: c["id"] for c in run["combatants"]}
    early = await table.c.post(
        f"/api/ttrpg/runs/{run['id']}/start",
        json={"base_revision": 1},
        headers=h(table.c),
    )
    assert early.status_code == 400 and "initiative" in early.text
    run = await table.setup(
        run,
        {
            ids["Brenna"]: 0,
            ids["Sildar"]: -3,
            ids["Goblin 1"]: 14,
            ids["Goblin 2"]: 21,
            ids["Goblin 3"]: 7,
        },
    )
    started = await table.start(run)
    assert order(started) == ["Goblin 2", "Goblin 1", "Goblin 3", "Brenna", "Sildar"]
    assert (started["status"], started["round"]) == ("active", 1)
    assert started["active_combatant_id"] == ids["Goblin 2"]
    assert started["history"][0]["summary"] == "The fight began"


async def test_ties_are_listed_and_resolved_by_hand(table: Table) -> None:
    run = await table.launch()
    ids = {c["name"]: c["id"] for c in run["combatants"]}
    run = await table.setup(
        run,
        {
            ids["Brenna"]: 15,
            ids["Sildar"]: 15,
            ids["Goblin 1"]: 15,
            ids["Goblin 2"]: 9,
            ids["Goblin 3"]: 9,
        },
    )
    assert sorted(map(sorted, run["ties"])) == sorted(
        [
            sorted([ids["Brenna"], ids["Sildar"], ids["Goblin 1"]]),
            sorted([ids["Goblin 2"], ids["Goblin 3"]]),
        ]
    )
    chosen = [ids["Goblin 1"], ids["Sildar"], ids["Brenna"], ids["Goblin 3"], ids["Goblin 2"]]
    started = await table.start(run, tie_order=chosen)
    assert order(started) == ["Goblin 1", "Sildar", "Brenna", "Goblin 3", "Goblin 2"]
    assert started["ties"] == []


async def test_without_a_tie_order_ties_follow_the_roster(table: Table) -> None:
    run = await table.launch()
    ids = {c["name"]: c["id"] for c in run["combatants"]}
    run = await table.setup(run, dict.fromkeys(ids.values(), 10))
    started = await table.start(run)
    assert order(started) == ["Brenna", "Sildar", "Goblin 1", "Goblin 2", "Goblin 3"]


async def test_turns_advance_wrap_the_round_and_skip_the_defeated(table: Table) -> None:
    run = await table.started()
    names = by_name(run)
    assert order(run) == ["Brenna", "Goblin 1", "Sildar", "Goblin 2", "Goblin 3"]
    assert run["active_combatant_id"] == names["Brenna"]["id"]
    run = await table.act(run, "damage", combatant_id=names["Goblin 2"]["id"], amount=7)  # defeated
    seen = []
    for _ in range(5):
        run = await table.act(run, "next_turn")
        seen.append(
            (
                by_name(run)[next(c["name"] for c in run["combatants"] if c["active"])]["name"],
                run["round"],
            )
        )
    assert seen == [
        ("Goblin 1", 1),
        ("Sildar", 1),
        ("Goblin 3", 1),  # the defeated Goblin 2 is skipped
        ("Brenna", 2),  # wrapped into round two
        ("Goblin 1", 2),
    ]
    assert run["history"][0]["summary"] == "Round 2: Goblin 1's turn"


async def test_a_party_member_at_zero_hp_keeps_taking_turns(table: Table) -> None:
    run = await table.started()
    sildar = by_name(run)["Sildar"]
    run = await table.act(run, "damage", combatant_id=sildar["id"], amount=99)
    row = by_name(run)["Sildar"]
    assert (row["hp"], row["defeated"]) == (0, False)
    for _ in range(2):
        run = await table.act(run, "next_turn")
    assert run["active_combatant_id"] == sildar["id"]


async def test_party_damage_writes_the_shared_party_state(table: Table) -> None:
    run = await table.started()
    brenna = by_name(run)["Brenna"]
    run = await table.act(run, "damage", combatant_id=brenna["id"], amount=9)
    state = (await table.c.get(f"/api/ttrpg/party/{table.brenna['id']}")).json()["state"]
    assert (state["current_hp"], state["revision"]) == (19, 2)
    row = by_name(run)["Brenna"]
    assert (row["hp"], row["party_revision"]) == (19, 2)
    # the party panel and the fight agree on temp HP, conditions, death saves and resources too
    run = await table.act(run, "temp_hp", combatant_id=brenna["id"], amount=4)
    run = await table.act(run, "add_condition", combatant_id=brenna["id"], condition="prone")
    run = await table.act(
        run, "spend_resource", combatant_id=brenna["id"], resource_key="second-wind", delta=1
    )
    state = (await table.c.get(f"/api/ttrpg/party/{table.brenna['id']}")).json()["state"]
    assert (state["temp_hp"], state["conditions"], state["resources_used"]) == (
        4,
        ["prone"],
        {"second-wind": 1},
    )
    assert state["revision"] == 5
    over = await table.raw(
        run, "spend_resource", combatant_id=brenna["id"], resource_key="second-wind", delta=1
    )
    assert over.status_code == 400
    run = await table.act(run, "damage", combatant_id=brenna["id"], amount=99)
    run = await table.act(run, "death_save", combatant_id=brenna["id"], death_save="failure")
    row = by_name(run)["Brenna"]
    assert (row["hp"], row["death_save_failures"], row["death_save_successes"]) == (0, 1, 0)
    run = await table.act(run, "heal", combatant_id=brenna["id"], amount=3)
    assert by_name(run)["Brenna"]["death_save_failures"] == 0  # healing clears the marks
    no_saves = await table.raw(run, "death_save", combatant_id=brenna["id"], death_save="success")
    assert no_saves.status_code == 400  # not at 0 HP any more


async def test_party_changes_need_the_current_party_revision(table: Table) -> None:
    run = await table.started()
    brenna = by_name(run)["Brenna"]
    missing = await table.raw(
        run, "damage", combatant_id=brenna["id"], amount=3, party_revisions={}
    )
    assert missing.status_code == 400
    # someone edits Brenna in the party panel after the DM's screen loaded
    edit = await table.c.patch(
        f"/api/ttrpg/party/{table.brenna['id']}/state",
        json={"base_revision": 1, "current_hp": 10},
        headers=h(table.c),
    )
    assert edit.status_code == 200
    stale = await table.raw(run, "damage", combatant_id=brenna["id"], amount=3)
    assert stale.status_code == 409
    detail = stale.json()["detail"]
    assert (detail["code"], detail["current_revision"]) == ("party_stale", 2)
    after = await table.get(run)
    assert after["revision"] == run["revision"]  # the run did not move
    assert by_name(after)["Brenna"]["hp"] == 10 and len(after["history"]) == 1
    fresh = await table.act(after, "damage", combatant_id=brenna["id"], amount=3)
    assert by_name(fresh)["Brenna"]["hp"] == 7


async def test_conditions_with_expiry_reminders_for_npcs_and_party(table: Table) -> None:
    run = await table.started()
    names = by_name(run)
    run = await table.act(
        run,
        "add_condition",
        combatant_id=names["Goblin 1"]["id"],
        condition="poisoned",
        expires_round=2,
    )
    run = await table.act(
        run, "add_condition", combatant_id=names["Sildar"]["id"], condition="prone"
    )
    assert by_name(run)["Goblin 1"]["conditions"] == ["poisoned"]
    assert by_name(run)["Goblin 1"]["condition_reminders"] == {"poisoned": 2}
    assert by_name(run)["Sildar"]["conditions"] == ["prone"]
    assert run["reminders_due"] == []
    for _ in range(5):
        run = await table.act(run, "next_turn")
    assert run["round"] == 2
    assert [(r["condition"], r["round"]) for r in run["reminders_due"]] == [("poisoned", 2)]
    assert by_name(run)["Goblin 1"]["conditions"] == ["poisoned"]  # reminded, never auto-removed
    again = await table.raw(
        run, "add_condition", combatant_id=names["Goblin 1"]["id"], condition="poisoned"
    )
    assert again.status_code == 400
    bad = await table.raw(
        run, "add_condition", combatant_id=names["Goblin 1"]["id"], condition="sleepy"
    )
    assert bad.status_code == 400
    run = await table.act(
        run, "remove_condition", combatant_id=names["Goblin 1"]["id"], condition="poisoned"
    )
    assert by_name(run)["Goblin 1"]["condition_reminders"] == {} and run["reminders_due"] == []


async def test_removing_the_active_combatant_passes_the_turn(table: Table) -> None:
    run = await table.started()
    names = by_name(run)
    run = await table.act(run, "next_turn")  # Goblin 1 is active
    run = await table.act(run, "remove_combatant", combatant_id=names["Goblin 1"]["id"])
    assert run["active_combatant_id"] == names["Sildar"]["id"] and run["round"] == 1
    assert by_name(run)["Goblin 1"]["removed"] is True
    assert run["history"][0]["summary"] == "Goblin 1 left the fight. Round 1: Sildar's turn"
    # removing the last in order while active wraps into the next round
    for _ in range(2):
        run = await table.act(run, "next_turn")
    assert by_name(run)["Goblin 3"]["active"] is True
    run = await table.act(run, "remove_combatant", combatant_id=names["Goblin 3"]["id"])
    assert (run["active_combatant_id"], run["round"]) == (names["Brenna"]["id"], 2)
    gone = await table.raw(run, "damage", combatant_id=names["Goblin 1"]["id"], amount=1)
    assert gone.status_code == 400  # removed combatants take no actions
    run = await table.act(run, "restore_combatant", combatant_id=names["Goblin 1"]["id"])
    assert by_name(run)["Goblin 1"]["removed"] is False


async def test_nobody_left_to_act_is_a_clear_end_state(table: Table) -> None:
    run = await table.started()
    for name in ("Brenna", "Sildar", "Goblin 1", "Goblin 2"):
        run = await table.act(run, "remove_combatant", combatant_id=by_name(run)[name]["id"])
        assert run["status"] == "active"
    run = await table.act(run, "remove_combatant", combatant_id=by_name(run)["Goblin 3"]["id"])
    assert (run["status"], run["end_reason"], run["active_combatant_id"]) == (
        "ended",
        "no_eligible_combatants",
        None,
    )
    # and the same when everyone left standing falls
    again = await Table(table.c).build(goblins=1, title="Second")
    run = await again.started({"Brenna": 20, "Sildar": 10, "Goblin": 5})
    for name in ("Brenna", "Sildar"):
        run = await again.act(run, "remove_combatant", combatant_id=by_name(run)[name]["id"])
    run = await again.act(run, "damage", combatant_id=by_name(run)["Goblin"]["id"], amount=7)
    run = await again.act(run, "next_turn")
    assert run["status"] == "ended" and run["end_reason"] == "no_eligible_combatants"
    refused = await again.raw(run, "next_turn")
    assert refused.status_code == 400


async def test_reinforcements_and_reordering(table: Table) -> None:
    run = await table.started()
    names = by_name(run)
    run = await table.act(
        run,
        "add_combatant",
        new_combatant={
            "name": "Goblin Boss",
            "ac": 17,
            "hp": 21,
            "initiative": 10,
            "side": "enemy",
        },
    )
    # acts after Goblin 2 (10 = 10) and before Goblin 3 (5)
    assert order(run) == ["Brenna", "Goblin 1", "Sildar", "Goblin 2", "Goblin Boss", "Goblin 3"]
    assert run["active_combatant_id"] == names["Brenna"]["id"]
    assert by_name(run)["Goblin Boss"]["hp"] == 21
    bad = await table.raw(run, "add_combatant", new_combatant={"name": "x", "ac": 1, "hp": 1})
    assert bad.status_code == 400  # needs an initiative total
    ids = [c["id"] for c in run["combatants"] if not c["removed"]]
    swapped = [ids[1], ids[0], *ids[2:]]
    run = await table.act(run, "reorder", order=swapped)
    assert order(run)[:2] == ["Goblin 1", "Brenna"]
    wrong = await table.raw(run, "reorder", order=ids[:-1])
    assert wrong.status_code == 400
    same = await table.raw(run, "reorder", order=swapped)
    assert same.status_code == 400


async def test_undo_restores_party_and_npc_state_in_one_step(table: Table) -> None:
    run = await table.started()
    names = by_name(run)
    run = await table.act(run, "damage", combatant_id=names["Brenna"]["id"], amount=9)
    run = await table.act(run, "damage", combatant_id=names["Goblin 1"]["id"], amount=7)
    assert by_name(run)["Goblin 1"]["defeated"] is True and run["undo_summary"].startswith(
        "Goblin 1 took 7"
    )

    undone = await table.undo(run)
    assert undone.status_code == 200, undone.text
    run = undone.json()["run"]
    assert (by_name(run)["Goblin 1"]["hp"], by_name(run)["Goblin 1"]["defeated"]) == (7, False)
    assert by_name(run)["Brenna"]["hp"] == 19  # the earlier action still stands
    run = (await table.undo(run)).json()["run"]
    assert by_name(run)["Brenna"]["hp"] == 28
    state = (await table.c.get(f"/api/ttrpg/party/{table.brenna['id']}")).json()["state"]
    assert state["current_hp"] == 28 and state["revision"] == 3  # restored values, newer revision
    assert [a["undone"] for a in run["history"] if a["kind"] == "damage"] == [True, True]
    assert run["history"][0]["kind"] == "undo" and run["history"][0]["summary"].startswith("Undid:")
    assert run["undo_summary"] is None
    nothing = await table.undo(run)
    assert nothing.status_code == 400


async def test_undoing_a_turn_condition_removal_and_reinforcement(table: Table) -> None:
    run = await table.started()
    names = by_name(run)
    start = (run["active_combatant_id"], run["round"])
    run = await table.act(run, "next_turn")
    run = (await table.undo(run)).json()["run"]
    assert (run["active_combatant_id"], run["round"]) == start

    run = await table.act(run, "remove_combatant", combatant_id=names["Brenna"]["id"])
    assert run["active_combatant_id"] != names["Brenna"]["id"]
    run = (await table.undo(run)).json()["run"]
    assert by_name(run)["Brenna"]["removed"] is False and run["active_combatant_id"] == start[0]

    before = order(run)
    run = await table.act(
        run, "add_combatant", new_combatant={"name": "Wolf", "ac": 13, "hp": 11, "initiative": 20}
    )
    assert order(run)[0] == "Wolf"
    run = (await table.undo(run)).json()["run"]
    assert order(run) == before and by_name(run)["Wolf"]["removed"] is True

    run = await table.act(
        run, "add_condition", combatant_id=names["Sildar"]["id"], condition="prone"
    )
    run = (await table.undo(run)).json()["run"]
    assert by_name(run)["Sildar"]["conditions"] == []
    state = (await table.c.get(f"/api/ttrpg/party/{table.sildar['id']}")).json()["state"]
    assert state["conditions"] == []


async def test_an_undo_that_was_superseded_is_a_conflict_and_keeps_the_newer_state(
    table: Table,
) -> None:
    run = await table.started()
    brenna = by_name(run)["Brenna"]
    run = await table.act(run, "damage", combatant_id=brenna["id"], amount=9)  # hp 19
    # the party panel corrects Brenna's hit points after that damage
    fix = await table.c.patch(
        f"/api/ttrpg/party/{table.brenna['id']}/state",
        json={"base_revision": 2, "current_hp": 25},
        headers=h(table.c),
    )
    assert fix.status_code == 200
    conflict = await table.undo(run)
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["code"] == "undo_conflict"
    assert "Brenna" in conflict.json()["detail"]["message"]
    after = await table.get(run)
    assert by_name(after)["Brenna"]["hp"] == 25  # the newer state is kept
    assert after["revision"] == run["revision"] and after["undo_summary"] is not None


async def test_a_retried_mutation_is_a_replay_not_a_second_application(table: Table) -> None:
    run = await table.started()
    goblin = by_name(run)["Goblin 1"]
    k = key()
    first = await table.raw(run, "damage", combatant_id=goblin["id"], amount=3, mutation_key=k)
    retry = await table.raw(run, "damage", combatant_id=goblin["id"], amount=3, mutation_key=k)
    assert (first.status_code, retry.status_code) == (200, 200)
    assert first.json()["replayed"] is False and retry.json()["replayed"] is True
    assert retry.json()["action"]["seq"] == first.json()["action"]["seq"]
    now = await table.get(run)
    assert by_name(now)["Goblin 1"]["hp"] == 4 and now["revision"] == run["revision"] + 1
    different = await table.raw(run, "damage", combatant_id=goblin["id"], amount=1, mutation_key=k)
    assert (
        different.status_code == 409 and different.json()["detail"]["code"] == "mutation_key_reused"
    )
    assert (await table.get(run))["revision"] == now["revision"]
    # an undo retried with its key does not undo a second action
    run = await table.act(now, "damage", combatant_id=goblin["id"], amount=1)
    uk = key()
    one = await table.undo(run, mutation_key=uk)
    two = await table.undo(run, mutation_key=uk)
    assert one.status_code == 200 and two.status_code == 200 and two.json()["replayed"] is True
    assert by_name(await table.get(run))["Goblin 1"]["hp"] == 4  # only the last damage was undone


async def test_two_tabs_acting_on_the_same_revision_let_one_win(table: Table) -> None:
    run = await table.started()
    goblin = by_name(run)["Goblin 1"]
    results = await asyncio.gather(
        table.raw(run, "damage", combatant_id=goblin["id"], amount=2),
        table.raw(run, "damage", combatant_id=goblin["id"], amount=2),
    )
    assert sorted(r.status_code for r in results) == [200, 409]
    loser = next(r for r in results if r.status_code == 409)
    assert loser.json()["detail"]["current_revision"] == run["revision"] + 1
    assert by_name(await table.get(run))["Goblin 1"]["hp"] == 5  # applied exactly once
    async with session_scope() as session:
        count = await session.scalar(
            select(func.count())
            .select_from(TtrpgCombatAction)
            .where(TtrpgCombatAction.kind == "damage")
        )
        assert count == 1


async def test_pause_resume_and_reload_recover_everything(table: Table) -> None:
    run = await table.started()
    names = by_name(run)
    run = await table.act(run, "damage", combatant_id=names["Brenna"]["id"], amount=5)
    run = await table.act(run, "next_turn")
    run = await table.act(
        run, "add_condition", combatant_id=names["Goblin 1"]["id"], condition="prone"
    )
    run = await table.act(run, "pause")
    assert run["status"] == "paused"
    blocked = await table.raw(run, "damage", combatant_id=names["Goblin 1"]["id"], amount=1)
    assert blocked.status_code == 400 and "paused" in blocked.text
    # "reload": a fresh read returns exactly what the screen showed
    reloaded = await table.get(run)
    for field in ("round", "active_combatant_id", "revision", "status"):
        assert reloaded[field] == run[field]
    for a, b in zip(reloaded["combatants"], run["combatants"], strict=True):
        assert {
            k: a[k]
            for k in ("id", "hp", "temp_hp", "conditions", "initiative", "order_index", "active")
        } == {
            k: b[k]
            for k in ("id", "hp", "temp_hp", "conditions", "initiative", "order_index", "active")
        }
    # the unfinished fight is listed for the next session and blocks a second one
    cid = table.campaign["id"]
    listing = (await table.c.get(f"/api/ttrpg/campaigns/{cid}/runs?unfinished=true")).json()[
        "items"
    ]
    assert [(r["id"], r["status"]) for r in listing] == [(run["id"], "paused")]
    assert (
        await table.c.post(f"/api/ttrpg/campaigns/{cid}/runs", json={}, headers=h(table.c))
    ).status_code == 409
    run = await table.act(run, "resume")
    run = await table.act(run, "damage", combatant_id=names["Goblin 1"]["id"], amount=1)
    assert by_name(run)["Goblin 1"]["hp"] == 6 and run["status"] == "active"
    # pausing is not a barrier for undo
    run = await table.act(run, "pause")
    resumed = await table.act(run, "resume")
    undone = (await table.undo(resumed)).json()["run"]
    assert by_name(undone)["Goblin 1"]["hp"] == 7


async def test_ending_keeps_history_and_the_final_party_state_and_frees_the_campaign(
    table: Table,
) -> None:
    run = await table.started()
    names = by_name(run)
    run = await table.act(run, "damage", combatant_id=names["Brenna"]["id"], amount=8)
    run = await table.act(run, "end", outcome="The goblins fled.")
    assert (run["status"], run["outcome"], run["end_reason"]) == (
        "ended",
        "The goblins fled.",
        "ended_by_dm",
    )
    assert run["active_combatant_id"] is None
    refused = await table.raw(run, "damage", combatant_id=names["Goblin 1"]["id"], amount=1)
    assert refused.status_code == 400
    history = (await table.c.get(f"/api/ttrpg/runs/{run['id']}/actions?limit=2")).json()["items"]
    assert [a["kind"] for a in history] == ["end", "damage"]
    older = (
        await table.c.get(f"/api/ttrpg/runs/{run['id']}/actions?before_seq={history[1]['seq']}")
    ).json()
    assert [a["kind"] for a in older["items"]] == ["start"]
    state = (await table.c.get(f"/api/ttrpg/party/{table.brenna['id']}")).json()["state"]
    assert state["current_hp"] == 20
    # the old run stays readable, even after the encounter and party member change
    await table.c.patch(
        f"/api/ttrpg/encounters/{table.encounter['id']}",
        json={"base_revision": table.encounter["revision"], "archived": True},
        headers=h(table.c),
    )
    await table.c.post(
        f"/api/ttrpg/party/{table.brenna['id']}/archive",
        json={"base_revision": 1, "archived": True},
        headers=h(table.c),
    )
    old = await table.get(run)
    assert by_name(old)["Brenna"]["name"] == "Brenna" and len(old["combatants"]) == 5
    cid = table.campaign["id"]
    assert (
        await table.c.post(f"/api/ttrpg/campaigns/{cid}/runs", json={}, headers=h(table.c))
    ).status_code == 201


async def test_a_second_fight_carries_the_party_forward_and_resets_the_enemies(
    table: Table,
) -> None:
    run = await table.started()
    names = by_name(run)
    brenna, sildar = names["Brenna"]["id"], names["Sildar"]["id"]
    run = await table.act(run, "damage", combatant_id=brenna, amount=11)
    run = await table.act(
        run, "spend_resource", combatant_id=brenna, resource_key="second-wind", delta=1
    )
    run = await table.act(run, "add_condition", combatant_id=sildar, condition="poisoned")
    run = await table.act(run, "damage", combatant_id=names["Goblin 1"]["id"], amount=7)
    run = await table.act(run, "end", outcome="Won.")

    second = await table.launch()
    rows = by_name(second)
    assert (rows["Brenna"]["hp"], rows["Brenna"]["resources"][0]["used"]) == (17, 1)
    assert rows["Sildar"]["conditions"] == ["poisoned"]
    assert [rows[f"Goblin {n}"]["hp"] for n in (1, 2, 3)] == [7, 7, 7]  # fresh enemies
    assert all(rows[f"Goblin {n}"]["defeated"] is False for n in (1, 2, 3))
    assert all(c["initiative"] is None for c in second["combatants"])  # initiative starts over
    # improvised: no encounter, every active party member, NPCs added in setup
    third = await table.raw(second, "end")
    assert third.status_code == 200
    impro = await table.c.post(
        f"/api/ttrpg/campaigns/{table.campaign['id']}/runs", json={}, headers=h(table.c)
    )
    body = impro.json()
    assert body["title"] == "Improvised fight" and sorted(by_name(body)) == ["Brenna", "Sildar"]
    added = await table.c.patch(
        f"/api/ttrpg/runs/{body['id']}/setup",
        json={
            "base_revision": body["revision"],
            "add": [{"name": "Bandit", "ac": 12, "hp": 11, "initiative": 8}],
        },
        headers=h(table.c),
    )
    assert added.status_code == 200 and "Bandit" in by_name(added.json())


async def test_setup_edits_and_validation(table: Table) -> None:
    run = await table.launch()
    ids = {c["name"]: c["id"] for c in run["combatants"]}
    run_after = await table.c.patch(
        f"/api/ttrpg/runs/{run['id']}/setup",
        json={"base_revision": 1, "set_removed": {ids["Goblin 3"]: True}},
        headers=h(table.c),
    )
    assert run_after.json()["revision"] == 2
    stale = await table.c.patch(
        f"/api/ttrpg/runs/{run['id']}/setup",
        json={"base_revision": 1, "initiative": {ids["Brenna"]: 5}},
        headers=h(table.c),
    )
    assert stale.status_code == 409
    for bad in (
        {"initiative": {str(uuid.uuid4()): 5}},
        {"initiative": {ids["Brenna"]: 101}},
        {"add": [{"name": "x"}]},
        {"bogus": 1},
    ):
        response = await table.c.patch(
            f"/api/ttrpg/runs/{run['id']}/setup",
            json={"base_revision": 2, **bad},
            headers=h(table.c),
        )
        assert response.status_code in (400, 422), (bad, response.text)
    # a removed combatant does not need initiative, and actions are refused before the start
    run = await table.setup(
        run_after.json(),
        {ids["Brenna"]: 1, ids["Sildar"]: 2, ids["Goblin 1"]: 3, ids["Goblin 2"]: 4},
    )
    early = await table.raw(run, "damage", combatant_id=ids["Goblin 1"], amount=1)
    assert early.status_code == 400
    started = await table.start(run)
    assert "Goblin 3" not in order(started)
    twice = await table.c.post(
        f"/api/ttrpg/runs/{run['id']}/start",
        json={"base_revision": started["revision"]},
        headers=h(table.c),
    )
    assert twice.status_code == 400
    cancelled = await Table(table.c).build(title="Third")  # another campaign: cancel from setup
    other = await cancelled.launch()
    ended = await cancelled.act(other, "end")
    assert (ended["status"], ended["end_reason"]) == ("ended", "cancelled")


@pytest.mark.parametrize(
    "body",
    [
        {"kind": "damage", "amount": 3},  # no combatant
        {"kind": "damage", "combatant_id": "x", "amount": 3},
        {"kind": "bogus"},
        {"kind": "damage", "amount": -1},
        {"kind": "next_turn", "extra": 1},
        {"kind": "death_save", "death_save": "maybe"},
        {"kind": "spend_resource", "delta": 2},
        {"kind": "next_turn", "mutation_key": "short"},
    ],
)
async def test_invalid_actions_are_rejected_and_change_nothing(
    table: Table, body: dict[str, Any]
) -> None:
    run = await table.started()
    payload = {"mutation_key": key(), "base_revision": run["revision"], **body}
    response = await table.c.post(
        f"/api/ttrpg/runs/{run['id']}/actions", json=payload, headers=h(table.c)
    )
    assert response.status_code in (400, 422), response.text
    after = await table.get(run)
    assert after["revision"] == run["revision"] and len(after["history"]) == 1


async def test_actions_on_unknown_combatants_and_wrong_kinds(table: Table) -> None:
    run = await table.started()
    goblin = by_name(run)["Goblin 1"]["id"]
    for kind, extra in (
        ("death_save", {"death_save": "success"}),
        ("spend_resource", {"resource_key": "x", "delta": 1}),
        ("set_defeated", {}),
    ):
        response = await table.raw(run, kind, combatant_id=goblin, **extra)
        assert response.status_code == 400, (kind, response.text)
    ghost = await table.raw(run, "damage", combatant_id=str(uuid.uuid4()), amount=1)
    assert ghost.status_code == 400
    run = await table.act(run, "set_defeated", combatant_id=goblin, defeated=True)
    assert by_name(run)["Goblin 1"]["defeated"] is True
    run = (await table.undo(run)).json()["run"]
    assert by_name(run)["Goblin 1"]["defeated"] is False
    brenna = by_name(run)["Brenna"]["id"]
    nope = await table.raw(run, "set_defeated", combatant_id=brenna, defeated=True)
    assert nope.status_code == 400  # party members are removed, never "defeated"


async def test_the_run_is_stored_not_derived_from_the_prep(table: Table) -> None:
    run = await table.started()
    goblin = by_name(run)["Goblin 1"]
    enc = (await table.c.get(f"/api/ttrpg/encounters/{table.encounter['id']}")).json()
    slot = enc["slots"][0]["id"]
    await table.c.delete(
        f"/api/ttrpg/encounters/{enc['id']}/slots/{slot}?base_revision={enc['revision']}",
        headers=h(table.c),
    )
    still = await table.get(run)
    assert by_name(still)["Goblin 1"]["max_hp"] == 7 and goblin["id"] in [
        c["id"] for c in still["combatants"]
    ]
    async with session_scope() as session:
        assert await session.scalar(select(func.count()).select_from(TtrpgCombatant)) == 5


async def test_ownership_and_the_disabled_switch(app: FastAPI, table: Table) -> None:
    run = await table.started()
    rid, cid = run["id"], table.campaign["id"]
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
        body = {"mutation_key": key(), "base_revision": 2, "kind": "next_turn"}
        for method, path, payload in (
            ("GET", f"/api/ttrpg/campaigns/{cid}/runs", None),
            ("POST", f"/api/ttrpg/campaigns/{cid}/runs", {}),
            ("GET", f"/api/ttrpg/runs/{rid}", None),
            ("PATCH", f"/api/ttrpg/runs/{rid}/setup", {"base_revision": 1}),
            ("POST", f"/api/ttrpg/runs/{rid}/start", {"base_revision": 1}),
            ("POST", f"/api/ttrpg/runs/{rid}/actions", body),
            ("POST", f"/api/ttrpg/runs/{rid}/undo", {"mutation_key": key(), "base_revision": 2}),
            ("GET", f"/api/ttrpg/runs/{rid}/actions", None),
        ):
            response = await other.request(method, path, json=payload, headers=h(other))
            assert response.status_code == 404, (method, path, response.status_code)
        mine = await other.post("/api/ttrpg/campaigns", json={"title": "Mine"}, headers=h(other))
        stolen = await other.post(
            f"/api/ttrpg/campaigns/{mine.json()['id']}/runs",
            json={"id": rid, "encounter_id": table.encounter["id"]},
            headers=h(other),
        )
        assert stolen.status_code in (404, 409)
    finally:
        await other.aclose()
    await table.c.put("/api/features/ttrpg", json={"enabled": False}, headers=h(table.c))
    assert (await table.c.get(f"/api/ttrpg/runs/{rid}")).status_code == 404
    await table.c.put("/api/features/ttrpg", json={"enabled": True}, headers=h(table.c))
    assert (await table.get(run))["round"] == 1  # disabling kept the paused/active fight
    async with session_scope() as session:
        stored = await session.scalar(select(TtrpgCombatRun.status))
        assert stored == "active"
        states = await session.scalar(select(func.count()).select_from(TtrpgPartyState))
        assert states == 2


async def test_ending_a_fight_drops_the_undo_payload_but_keeps_the_readable_history(
    table: Table,
) -> None:
    run = await table.started()
    names = by_name(run)
    run = await table.act(run, "damage", combatant_id=names["Brenna"]["id"], amount=9)
    run = await table.act(run, "next_turn")
    async with session_scope() as session:  # while it runs, the payload is there for undo
        live = (
            await session.scalars(
                select(TtrpgCombatAction).where(TtrpgCombatAction.kind == "damage")
            )
        ).one()
        assert live.before and live.after and live.reversible
    run = await table.act(run, "end", outcome="Done.")
    assert run["status"] == "ended"
    async with session_scope() as session:
        rows = list(
            (await session.scalars(select(TtrpgCombatAction).order_by(TtrpgCombatAction.seq))).all()
        )
        assert [r.kind for r in rows] == ["start", "damage", "next_turn", "end"]
        assert all(r.before == {} and r.after == {} and not r.reversible for r in rows)
        assert rows[1].summary == "Brenna took 9 (HP 28 → 19)"
    history = (await table.c.get(f"/api/ttrpg/runs/{run['id']}/actions")).json()["items"]
    assert [a["summary"] for a in history][1] == "Round 1: Goblin 1's turn"
    assert all(a["reversible"] is False for a in history)
    assert (await table.get(run))["undo_summary"] is None
    # the party keeps the state the fight left it in
    state = (await table.c.get(f"/api/ttrpg/party/{table.brenna['id']}")).json()["state"]
    assert state["current_hp"] == 19


async def test_manual_play_actions_set_exact_values_and_never_decide_for_the_dm(
    table: Table,
) -> None:
    run = await table.started()
    names = by_name(run)
    g2, brenna = names["Goblin 2"]["id"], names["Brenna"]["id"]

    # typing an exact HP value is a correction: 0 HP does not mark anyone defeated or skip them
    run = await table.act(run, "set_hp", combatant_id=g2, hp=0)
    assert (by_name(run)["Goblin 2"]["hp"], by_name(run)["Goblin 2"]["defeated"]) == (0, False)
    visited = []
    for _ in range(5):
        run = await table.act(run, "next_turn")
        visited.append(next(c["name"] for c in run["combatants"] if c["active"]))
    assert "Goblin 2" in visited  # still takes its turn until the DM takes it out
    run = await table.act(run, "set_hp", combatant_id=g2, hp=3)
    assert by_name(run)["Goblin 2"]["defeated"] is False
    # damage and healing keep their helper (the API is shared with other clients)
    run = await table.act(run, "damage", combatant_id=g2, amount=3)
    assert by_name(run)["Goblin 2"]["defeated"] is True

    # temporary HP: exactly the number typed (replaced, not stacked), for an NPC and a party member
    run = await table.act(run, "set_temp_hp", combatant_id=g2, amount=5)
    run = await table.act(run, "set_temp_hp", combatant_id=g2, amount=2)
    assert by_name(run)["Goblin 2"]["temp_hp"] == 2
    run = await table.act(run, "set_temp_hp", combatant_id=brenna, amount=7)
    state = (await table.c.get(f"/api/ttrpg/party/{table.brenna['id']}")).json()["state"]
    assert state["temp_hp"] == 7 and by_name(run)["Brenna"]["temp_hp"] == 7
    same = await table.raw(run, "set_temp_hp", combatant_id=g2, amount=2)
    assert same.status_code == 400
    run = (await table.undo(run)).json()["run"]
    assert by_name(run)["Brenna"]["temp_hp"] == 0

    # whose turn it is, by hand; the round does not change
    sildar = names["Sildar"]["id"]
    before = run["round"]
    run = await table.act(run, "set_active", combatant_id=sildar)
    assert run["active_combatant_id"] == sildar and run["round"] == before
    assert (await table.raw(run, "set_active", combatant_id=sildar)).status_code == 400
    run = (await table.undo(run)).json()["run"]
    assert run["active_combatant_id"] != sildar

    # the round counter and initiative totals, by hand
    run = await table.act(run, "set_round", round_number=4)
    assert run["round"] == 4
    assert (await table.raw(run, "set_round", round_number=4)).status_code == 400
    assert (await table.raw(run, "set_round", round_number=0)).status_code == 422
    run = (await table.undo(run)).json()["run"]
    assert run["round"] == before
    run = await table.act(run, "set_initiative", combatant_id=g2, initiative=-3)
    assert by_name(run)["Goblin 2"]["initiative"] == -3
    assert order(run) == order(await table.get(run))  # the order itself did not move
    assert (
        await table.raw(run, "set_initiative", combatant_id=g2, initiative=101)
    ).status_code == 422
    run = (await table.undo(run)).json()["run"]
    assert by_name(run)["Goblin 2"]["initiative"] == 10
    for kind, extra in (
        ("set_active", {}),
        ("set_temp_hp", {"combatant_id": g2}),
        ("set_initiative", {"combatant_id": g2}),
    ):
        assert (
            await table.raw(run, kind, **extra)
        ).status_code == 400  # a required value is missing
