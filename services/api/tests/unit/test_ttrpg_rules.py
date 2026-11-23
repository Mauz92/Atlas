"""The 2014 preset's pure functions (TTRPG-03)."""

from __future__ import annotations

import pytest

from atlas.ttrpg import rules
from atlas.ttrpg.rules import ResourceDef, apply_damage, apply_healing, grant_temp_hp, preview_rest


@pytest.mark.parametrize(
    ("hp", "temp", "amount", "expected"),
    [
        (10, 0, 3, (7, 0)),
        (10, 5, 3, (10, 2)),  # temporary hit points absorb first
        (10, 5, 5, (10, 0)),
        (10, 5, 8, (7, 0)),  # the remainder hits real hit points
        (10, 0, 99, (0, 0)),  # never below zero
        (0, 0, 4, (0, 0)),
        (10, 3, 0, (10, 3)),
    ],
)
def test_damage(hp: int, temp: int, amount: int, expected: tuple[int, int]) -> None:
    assert apply_damage(hp, temp, amount) == expected


def test_healing_caps_and_temp_hp_does_not_stack() -> None:
    assert apply_healing(4, 12, 5) == 9
    assert apply_healing(10, 12, 50) == 12
    assert apply_healing(0, 12, 1) == 1
    assert grant_temp_hp(5, 3) == 5
    assert grant_temp_hp(2, 7) == 7


@pytest.mark.parametrize("fn", [lambda: apply_damage(1, 0, -1), lambda: apply_healing(1, 5, -1)])
def test_negative_amounts_are_refused(fn: object) -> None:
    with pytest.raises(ValueError):
        fn()  # type: ignore[operator]


RESOURCES = [
    ResourceDef("second-wind", 1, "short"),
    ResourceDef("action-surge", 1, "short"),
    ResourceDef("indomitable", 1, "long"),
    ResourceDef("luck", 3, "none"),
]


def _rest(kind: rules.RestKind, **overrides: object):
    base = {
        "max_hp": 30,
        "hp": 12,
        "temp_hp": 4,
        "exhaustion_level": 2,
        "death_save_successes": 1,
        "death_save_failures": 0,
        "resources": RESOURCES,
        "resources_used": {"second-wind": 1, "indomitable": 1, "luck": 2},
    }
    base.update(overrides)
    return preview_rest(kind, **base)  # type: ignore[arg-type]


def test_short_rest_restores_only_short_resources_and_leaves_hp_to_the_dm() -> None:
    change = _rest("short")
    assert change.resources_used == {"second-wind": (1, 0)}
    assert change.hp is None and change.temp_hp is None and change.exhaustion_level is None
    assert not change.death_saves_cleared


def test_long_rest_restores_hp_resources_exhaustion_and_clears_saves() -> None:
    change = _rest("long")
    assert change.hp == (12, 30)
    assert change.temp_hp == (4, 0)
    assert change.exhaustion_level == (2, 1)
    assert change.death_saves_cleared
    assert change.resources_used == {"second-wind": (1, 0), "indomitable": (1, 0)}
    assert "luck" not in change.resources_used  # reset "none" is never touched


def test_a_rest_with_nothing_to_do_is_empty() -> None:
    change = _rest(
        "long",
        hp=30,
        temp_hp=0,
        exhaustion_level=0,
        death_save_successes=0,
        resources_used={},
    )
    assert change.is_empty
    assert _rest("short", resources_used={}).is_empty
