"""The SRD catalogue adapter against a fake transport (TTRPG-04). No network is used."""

from __future__ import annotations

import copy
from typing import Any

import pytest

from atlas.ttrpg.srd import (
    HttpSrdCatalog,
    SrdMalformedError,
    SrdNotFoundError,
    SrdUnavailableError,
    normalize_monster,
)
from tests.fakes.srd_provider import GOBLIN, FakeSrd


def catalog(fake: FakeSrd, clock: Any = None) -> HttpSrdCatalog:
    kwargs: dict[str, Any] = {"transport": fake.transport(), "timeout": 2.0}
    if clock is not None:
        kwargs["clock"] = clock
    return HttpSrdCatalog("https://srd.example", **kwargs)


async def test_search_is_local_after_one_index_fetch_and_prefers_prefix_matches() -> None:
    fake = FakeSrd()
    srd = catalog(fake)
    assert [e.name for e in await srd.search("gob")] == ["Goblin", "Goblin Boss"]
    assert [e.index for e in await srd.search("WOLF")] == ["wolf"]
    assert await srd.search("dragon") == []
    assert len(await srd.search("")) == 3
    assert [r.url.path for r in fake.requests] == ["/api/2014/monsters"]  # one request only
    assert all(r.url.query == b"" for r in fake.requests)  # the search text never leaves Atlas


async def test_fetch_normalises_a_monster() -> None:
    monster = await catalog(FakeSrd()).fetch("goblin")
    assert (monster.name, monster.ac, monster.hp, monster.initiative_mod) == ("Goblin", 15, 7, 2)
    assert monster.challenge_rating == "1/4" and monster.speed == "walk 30 ft."
    assert monster.traits[0].name == "Nimble Escape"
    action = monster.actions[0]
    assert (action.name, action.to_hit, action.damage) == ("Scimitar", 4, "1d6+2 Slashing")


async def test_only_the_two_documented_request_shapes_are_sent() -> None:
    fake = FakeSrd()
    srd = catalog(fake)
    await srd.search("go")
    await srd.fetch("goblin")
    assert {(r.method, r.url.host, r.url.path) for r in fake.requests} == {
        ("GET", "srd.example", "/api/2014/monsters"),
        ("GET", "srd.example", "/api/2014/monsters/goblin"),
    }
    for hostile in ("../etc/passwd", "gob lin", "Goblin", "a/b", "", "x" * 101, "goblin?x=1"):
        with pytest.raises(SrdNotFoundError):
            await srd.fetch(hostile)
    assert len(fake.requests) == 2  # a bad index never reaches the network


@pytest.mark.parametrize("mode", ["down", "timeout"])
async def test_outages_are_reported_without_provider_content(mode: str) -> None:
    fake = FakeSrd()
    fake.mode = mode
    with pytest.raises(SrdUnavailableError) as caught:
        await catalog(fake).fetch("goblin")
    assert "maintenance" not in str(caught.value) and "srd.example" not in str(caught.value)


async def test_garbage_oversized_and_redirected_answers_are_refused() -> None:
    for mode, error in (
        ("garbage", SrdMalformedError),
        ("huge", SrdMalformedError),
        ("redirect", SrdUnavailableError),
    ):
        fake = FakeSrd()
        fake.mode = mode
        with pytest.raises(error):
            await catalog(fake).fetch("goblin")
        assert all(r.url.host == "srd.example" for r in fake.requests)  # no redirect followed


async def test_a_missing_monster_is_not_found() -> None:
    with pytest.raises(SrdNotFoundError):
        await catalog(FakeSrd()).fetch("tarrasque")


async def test_the_index_is_cached_and_a_stale_copy_survives_an_outage() -> None:
    fake = FakeSrd()
    now = [0.0]
    srd = catalog(fake, clock=lambda: now[0])
    await srd.search("")
    await srd.search("")
    assert len(fake.requests) == 1
    now[0] = 7 * 3600
    fake.mode = "down"
    assert [e.index for e in await srd.search("wolf")] == ["wolf"]  # stale beats failing
    assert len(fake.requests) == 2
    cold = catalog(fake)
    with pytest.raises(SrdUnavailableError):
        await cold.search("wolf")  # nothing to fall back on


async def test_an_index_mismatch_is_malformed() -> None:
    fake = FakeSrd()
    fake.monsters["goblin"] = {**GOBLIN, "index": "wolf"}
    with pytest.raises(SrdMalformedError):
        await catalog(fake).fetch("goblin")


@pytest.mark.parametrize(
    "mutate",
    [
        lambda d: d.pop("armor_class"),
        lambda d: d.update(armor_class=[]),
        lambda d: d.update(armor_class=[{"value": "fifteen"}]),
        lambda d: d.update(armor_class=[{"value": 999}]),
        lambda d: d.update(hit_points=0),
        lambda d: d.update(hit_points=True),
        lambda d: d.update(hit_points=float("nan")),
        lambda d: d.update(name=""),
        lambda d: d.update(name=5),
        lambda d: d.update(index="Bad Index"),
        lambda d: d.update(special_abilities="nope"),
        lambda d: d.update(special_abilities=[{"desc": "no name"}]),
        lambda d: d.update(actions=[{"name": "x", "attack_bonus": "big"}]),
        lambda d: d.update(challenge_rating="three"),
        lambda d: d.update(challenge_rating=99),
        lambda d: d.update(dexterity=0),
    ],
)
def test_malformed_payloads_are_never_half_imported(mutate: Any) -> None:
    data = copy.deepcopy(GOBLIN)
    mutate(data)
    with pytest.raises(SrdMalformedError):
        normalize_monster(data)


def test_text_is_plain_bounded_and_stripped_of_control_characters() -> None:
    data = copy.deepcopy(GOBLIN)
    data["name"] = "Gob\x00lin\x07 <script>alert(1)</script>"
    data["special_abilities"] = [{"name": "Long", "desc": "x" * 9000}]
    monster = normalize_monster(data)
    assert "\x00" not in monster.name and "\x07" not in monster.name
    assert "<script>" in monster.name  # kept as inert text; rendering never treats it as HTML
    assert len(monster.traits[0].text) == 4000


def test_challenge_ratings_map_to_the_book_notation() -> None:
    for value, expected in ((0, "0"), (0.125, "1/8"), (0.5, "1/2"), (3, "3"), (30, "30")):
        data = copy.deepcopy(GOBLIN)
        data["challenge_rating"] = value
        assert normalize_monster(data).challenge_rating == expected


def test_the_attribution_is_wizards_own_wording_for_srd_5_1() -> None:
    """Word for word from the "Legal Information" page of SRD_CC_v5.1.pdf (2026-11-23)."""
    from atlas.ttrpg.srd import ATTRIBUTION

    assert ATTRIBUTION == (
        "This work includes material taken from the System Reference Document 5.1 "
        "(\u201cSRD 5.1\u201d) by Wizards of the Coast LLC and available at "
        "https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1 is licensed "
        "under the Creative Commons Attribution 4.0 International License available at "
        "https://creativecommons.org/licenses/by/4.0/legalcode."
    )
    # nothing else about Wizards is claimed (their licence page asks for that)
    assert ATTRIBUTION.count("Wizards") == 1
