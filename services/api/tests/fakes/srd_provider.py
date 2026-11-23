"""An in-process stand-in for the 5e SRD API (TTRPG-04): recorded-shape fixtures, no network."""

from __future__ import annotations

import json
from typing import Any

import httpx

GOBLIN: dict[str, Any] = {
    "index": "goblin",
    "name": "Goblin",
    "size": "Small",
    "type": "humanoid",
    "armor_class": [{"type": "armor", "value": 15}],
    "hit_points": 7,
    "hit_points_roll": "2d6",
    "speed": {"walk": "30 ft."},
    "dexterity": 14,
    "challenge_rating": 0.25,
    "special_abilities": [
        {"name": "Nimble Escape", "desc": "Disengage or Hide as a bonus action."}
    ],
    "actions": [
        {
            "name": "Scimitar",
            "desc": "Melee Weapon Attack: +4 to hit.",
            "attack_bonus": 4,
            "damage": [{"damage_type": {"name": "Slashing"}, "damage_dice": "1d6+2"}],
        }
    ],
}
WOLF: dict[str, Any] = {
    "index": "wolf",
    "name": "Wolf",
    "size": "Medium",
    "type": "beast",
    "armor_class": [{"type": "natural", "value": 13}],
    "hit_points": 11,
    "speed": {"walk": "40 ft."},
    "dexterity": 15,
    "challenge_rating": 0.25,
    "actions": [],
}
INDEX = {
    "count": 3,
    "results": [
        {"index": "goblin", "name": "Goblin", "url": "/api/2014/monsters/goblin"},
        {"index": "goblin-boss", "name": "Goblin Boss", "url": "/api/2014/monsters/goblin-boss"},
        {"index": "wolf", "name": "Wolf", "url": "/api/2014/monsters/wolf"},
    ],
}


class FakeSrd:
    """Records every request so tests can prove what was (and was not) sent."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.monsters: dict[str, Any] = {"goblin": dict(GOBLIN), "wolf": dict(WOLF)}
        self.index: Any = INDEX
        self.mode = "ok"  # ok | down | timeout | garbage | huge | redirect

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.mode == "timeout":
            raise httpx.ReadTimeout("slow", request=request)
        if self.mode == "down":
            return httpx.Response(503, text="maintenance")
        if self.mode == "garbage":
            return httpx.Response(200, text="<html>not json</html>")
        if self.mode == "huge":
            return httpx.Response(200, content=b"[" + b"1," * 400_000 + b"1]")
        if self.mode == "redirect":
            return httpx.Response(302, headers={"Location": "http://evil.example/steal"})
        path = request.url.path
        if path == "/api/2014/monsters":
            return httpx.Response(200, json=self.index)
        if path.startswith("/api/2014/monsters/"):
            monster = self.monsters.get(path.rsplit("/", 1)[1])
            if monster is None:
                return httpx.Response(404, json={"error": "Not found"})
            return httpx.Response(200, content=json.dumps(monster).encode())
        return httpx.Response(404)

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self)
