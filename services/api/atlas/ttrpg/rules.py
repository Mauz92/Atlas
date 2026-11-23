"""The D&D 5e (2014) preset: pure functions, no database and no I/O (TTRPG-03).

Everything the plan calls "rules" lives here so it can be tested without a server and replaced
per preset later: condition names, damage and healing arithmetic, and what a rest restores. Where
the rules need a table's judgement (hit dice, which features recharge) the preview is only a
*proposal* that the DM may override.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

PRESET_ID = "dnd5e-2014"

#: Conditions of the 2014 rules except exhaustion, which has levels and its own field.
CONDITIONS: tuple[str, ...] = (
    "blinded",
    "charmed",
    "deafened",
    "frightened",
    "grappled",
    "incapacitated",
    "invisible",
    "paralyzed",
    "petrified",
    "poisoned",
    "prone",
    "restrained",
    "stunned",
    "unconscious",
)
MAX_EXHAUSTION = 6
DEATH_SAVE_LIMIT = 3

RestKind = Literal["short", "long"]
ResetOn = Literal["short", "long", "none"]


def apply_damage(hp: int, temp_hp: int, amount: int) -> tuple[int, int]:
    """Temporary hit points absorb damage first; hit points never go below zero."""
    if amount < 0:
        raise ValueError("damage must not be negative")
    absorbed = min(temp_hp, amount)
    remaining = amount - absorbed
    return max(0, hp - remaining), temp_hp - absorbed


def apply_healing(hp: int, max_hp: int, amount: int) -> int:
    """Healing raises hit points up to the maximum and never touches temporary hit points."""
    if amount < 0:
        raise ValueError("healing must not be negative")
    return min(max_hp, hp + amount)


def grant_temp_hp(current_temp: int, amount: int) -> int:
    """Temporary hit points do not stack: keep the larger of the old and the new amount."""
    if amount < 0:
        raise ValueError("temporary hit points must not be negative")
    return max(current_temp, amount)


@dataclass(frozen=True)
class ResourceDef:
    key: str
    max: int
    reset: ResetOn


@dataclass(frozen=True)
class RestChange:
    """What one rest would change for one party member (``None`` = unchanged)."""

    hp: tuple[int, int] | None
    temp_hp: tuple[int, int] | None
    exhaustion_level: tuple[int, int] | None
    death_saves_cleared: bool
    resources_used: dict[str, tuple[int, int]]

    @property
    def is_empty(self) -> bool:
        return (
            self.hp is None
            and self.temp_hp is None
            and self.exhaustion_level is None
            and not self.death_saves_cleared
            and not self.resources_used
        )


def preview_rest(
    kind: RestKind,
    *,
    max_hp: int,
    hp: int,
    temp_hp: int,
    exhaustion_level: int,
    death_save_successes: int,
    death_save_failures: int,
    resources: Sequence[ResourceDef],
    resources_used: Mapping[str, int],
) -> RestChange:
    """The proposed effect of a rest.

    * Short rest: restores resources that reset on a short rest. Hit dice are not tracked, so hit
      points are left for the DM to enter.
    * Long rest: hit points to the maximum, temporary hit points end, death saves clear, resources
      that reset on a short or long rest are restored and exhaustion drops by one level.
    """
    restores = {"short"} if kind == "short" else {"short", "long"}
    changed: dict[str, tuple[int, int]] = {}
    for resource in resources:
        used = resources_used.get(resource.key, 0)
        if resource.reset in restores and used != 0:
            changed[resource.key] = (used, 0)
    if kind == "short":
        return RestChange(None, None, None, False, changed)
    return RestChange(
        hp=(hp, max_hp) if hp != max_hp else None,
        temp_hp=(temp_hp, 0) if temp_hp else None,
        exhaustion_level=(
            (exhaustion_level, exhaustion_level - 1) if exhaustion_level > 0 else None
        ),
        death_saves_cleared=bool(death_save_successes or death_save_failures),
        resources_used=changed,
    )
