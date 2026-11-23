"""The D&D 5e (2014) SRD monster catalogue adapter (TTRPG-04).

Everything provider-specific lives here. The rest of Atlas sees :class:`SrdCatalog` and the
normalised :class:`SrdMonster`; it never sees a provider payload.

Network rules (AGENTS.md section 11):

* only two request shapes are ever sent, ``GET /api/2014/monsters`` and
  ``GET /api/2014/monsters/<index>`` (``index`` is validated), to the one configured origin, with
  bounded timeouts, bounded response sizes and **no redirects followed**;
* no campaign, note or player data is part of any request (name search runs on a local copy of the
  index);
* error messages are content-free (no URL, body or header).

The text is plain text: it is stored and returned as strings and rendered by React as text, never as
HTML. The provider payload is validated field by field; anything unexpected is a *malformed* error,
never a half-imported card.
"""

from __future__ import annotations

import json
import math
import re
import time
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx

EDITION = "2014"
API_PATH = "/api/2014/monsters"
#: The statement Wizards of the Coast requires, word for word as printed on the "Legal
#: Information" page of SRD_CC_v5.1.pdf (checked against the PDF on 2026-11-23). Wizards also
#: asks for no other attribution regarding them; "compatible with fifth edition" or "5E
#: compatible" may be stated.
ATTRIBUTION = (
    "This work includes material taken from the System Reference Document 5.1 "
    "(\u201cSRD 5.1\u201d) by Wizards of the Coast LLC and available at "
    "https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1 is licensed under "
    "the Creative Commons Attribution 4.0 International License available at "
    "https://creativecommons.org/licenses/by/4.0/legalcode."
)

MAX_INDEX_BYTES = 2 * 1024 * 1024
MAX_MONSTER_BYTES = 256 * 1024
INDEX_TTL_SECONDS = 6 * 3600
MAX_RESULTS = 25

_INDEX = re.compile(r"^[a-z0-9][a-z0-9-]{0,99}$")
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class SrdError(Exception):
    """Base of every catalogue failure; the message is safe to show (no provider content)."""


class SrdDisabledError(SrdError):
    pass


class SrdUnavailableError(SrdError):
    """Timeout, connection failure, or a provider error status."""


class SrdMalformedError(SrdError):
    """The provider answered with something that is not the documented shape."""


class SrdNotFoundError(SrdError):
    pass


@dataclass(frozen=True)
class SrdIndexEntry:
    index: str
    name: str


@dataclass(frozen=True)
class SrdAction:
    name: str
    text: str
    kind: str  # action | reaction | legendary
    to_hit: int | None = None
    damage: str = ""


@dataclass(frozen=True)
class SrdTrait:
    name: str
    text: str


@dataclass(frozen=True)
class SrdMonster:
    index: str
    name: str
    ac: int
    hp: int
    speed: str | None
    initiative_mod: int
    challenge_rating: str | None
    size: str | None
    creature_type: str | None
    traits: list[SrdTrait] = field(default_factory=list)
    actions: list[SrdAction] = field(default_factory=list)


class SrdCatalog(Protocol):
    async def search(self, query: str) -> list[SrdIndexEntry]: ...

    async def fetch(self, index: str) -> SrdMonster: ...


def clean_text(value: object, limit: int) -> str:
    """Plain text only: control characters removed, whitespace trimmed, length bounded."""
    if not isinstance(value, str):
        raise SrdMalformedError("expected text")
    return _CONTROL.sub("", value).strip()[:limit]


def _int(value: object, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        raise SrdMalformedError("expected a number")
    number = int(value)
    if not low <= number <= high:
        raise SrdMalformedError("number out of range")
    return number


def _challenge(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise SrdMalformedError("expected a challenge rating")
    fractions = {0.125: "1/8", 0.25: "1/4", 0.5: "1/2"}
    if value in fractions:
        return fractions[float(value)]
    if float(value).is_integer() and 0 <= value <= 30:
        return str(int(value))
    raise SrdMalformedError("unexpected challenge rating")


def _list(value: object) -> list[Any]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise SrdMalformedError("expected a list")
    return value


def _object(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise SrdMalformedError("expected an object")
    return value


def _damage(action: dict[str, Any]) -> str:
    parts: list[str] = []
    for item in _list(action.get("damage"))[:4]:
        entry = _object(item)
        dice = entry.get("damage_dice")
        if not isinstance(dice, str):
            continue
        kind = entry.get("damage_type")
        label = kind.get("name") if isinstance(kind, dict) else None
        parts.append(
            clean_text(dice, 40) + (f" {clean_text(label, 40)}" if isinstance(label, str) else "")
        )
    return " + ".join(parts)


def normalize_monster(payload: object) -> SrdMonster:
    """Validate and normalise one provider monster; raises :class:`SrdMalformedError`."""
    data = _object(payload)
    index = data.get("index")
    if not isinstance(index, str) or not _INDEX.match(index):
        raise SrdMalformedError("bad index")
    name = clean_text(data.get("name"), 120)
    if not name:
        raise SrdMalformedError("missing name")
    armor = _list(data.get("armor_class"))
    if not armor:
        raise SrdMalformedError("missing armor class")
    ac = _int(_object(armor[0]).get("value"), 0, 40)
    hp = _int(data.get("hit_points"), 1, 9999)
    dexterity = data.get("dexterity", 10)
    mod = (_int(dexterity, 1, 40) - 10) // 2
    speed_raw = data.get("speed")
    speed: str | None = None
    if isinstance(speed_raw, dict):
        speed = (
            ", ".join(
                f"{clean_text(k, 20)} {clean_text(v, 30)}"
                for k, v in list(speed_raw.items())[:8]
                if isinstance(v, str)
            )[:200]
            or None
        )
    traits = [
        SrdTrait(
            clean_text(_object(item).get("name"), 120),
            clean_text(_object(item).get("desc", ""), 4000),
        )
        for item in _list(data.get("special_abilities"))[:30]
    ]
    actions: list[SrdAction] = []
    for kind, key in (
        ("action", "actions"),
        ("reaction", "reactions"),
        ("legendary", "legendary_actions"),
    ):
        for item in _list(data.get(key))[:30]:
            entry = _object(item)
            bonus = entry.get("attack_bonus")
            actions.append(
                SrdAction(
                    name=clean_text(entry.get("name"), 120),
                    text=clean_text(entry.get("desc", ""), 4000),
                    kind=kind,
                    to_hit=_int(bonus, -20, 40) if bonus is not None else None,
                    damage=_damage(entry),
                )
            )
    if any(not trait.name for trait in traits) or any(not a.name for a in actions):
        raise SrdMalformedError("unnamed trait or action")
    size = data.get("size")
    type_value = data.get("type")
    return SrdMonster(
        index=index,
        name=name,
        ac=ac,
        hp=hp,
        speed=speed,
        initiative_mod=mod,
        challenge_rating=_challenge(data.get("challenge_rating")),
        size=clean_text(size, 32) if isinstance(size, str) else None,
        creature_type=clean_text(type_value, 120) if isinstance(type_value, str) else None,
        traits=traits,
        actions=actions,
    )


def parse_index(payload: object) -> list[SrdIndexEntry]:
    data = _object(payload)
    entries: list[SrdIndexEntry] = []
    for item in _list(data.get("results")):
        entry = _object(item)
        index = entry.get("index")
        if not isinstance(index, str) or not _INDEX.match(index):
            raise SrdMalformedError("bad index entry")
        entries.append(SrdIndexEntry(index, clean_text(entry.get("name"), 120) or index))
    return entries


class HttpSrdCatalog:
    """The real catalogue over HTTP (a test installs ``transport``; nothing else differs)."""

    def __init__(
        self,
        base_url: str,
        *,
        timeout: float = 8.0,
        transport: httpx.AsyncBaseTransport | None = None,
        clock: Any = time.monotonic,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._timeout = timeout
        self._transport = transport
        self._clock = clock
        self._index: list[SrdIndexEntry] | None = None
        self._index_at = 0.0

    async def _get(self, path: str, limit: int) -> object:
        timeout = httpx.Timeout(self._timeout, connect=min(self._timeout, 3.0))
        try:
            async with (
                httpx.AsyncClient(
                    timeout=timeout, follow_redirects=False, transport=self._transport
                ) as client,
                client.stream(
                    "GET", f"{self._base}{path}", headers={"Accept": "application/json"}
                ) as response,
            ):
                if response.status_code == 404:
                    raise SrdNotFoundError("not in the catalogue")
                if response.status_code != 200:
                    raise SrdUnavailableError("the monster catalogue is not available")
                body = b""
                async for chunk in response.aiter_bytes():
                    body += chunk
                    if len(body) > limit:
                        raise SrdMalformedError("response too large")
        except httpx.HTTPError as exc:
            raise SrdUnavailableError("the monster catalogue is not available") from exc
        try:
            return json.loads(body)
        except ValueError as exc:
            raise SrdMalformedError("not JSON") from exc

    async def _entries(self) -> list[SrdIndexEntry]:
        fresh = self._index is not None and self._clock() - self._index_at < INDEX_TTL_SECONDS
        if fresh and self._index is not None:
            return self._index
        try:
            entries = parse_index(await self._get(API_PATH, MAX_INDEX_BYTES))
        except SrdError:
            if self._index is not None:  # a stale copy beats an outage
                return self._index
            raise
        self._index, self._index_at = entries, self._clock()
        return entries

    async def search(self, query: str) -> list[SrdIndexEntry]:
        needle = query.strip().casefold()
        entries = await self._entries()
        hits = [e for e in entries if not needle or needle in e.name.casefold()]
        hits.sort(key=lambda e: (not e.name.casefold().startswith(needle), e.name.casefold()))
        return hits[:MAX_RESULTS]

    async def fetch(self, index: str) -> SrdMonster:
        if not _INDEX.match(index):
            raise SrdNotFoundError("not in the catalogue")
        monster = normalize_monster(await self._get(f"{API_PATH}/{index}", MAX_MONSTER_BYTES))
        if monster.index != index:
            raise SrdMalformedError("index mismatch")
        return monster
