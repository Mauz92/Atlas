"""Model/real conformance (SYNC-02, layer C of TESTING.md section 10).

The same sequential traces run against the in-memory model server and against the real FastAPI
application on PostgreSQL; the normalised responses must be identical. This is what justifies using
the model for thousands of seeds: wherever the model and the real API differ, the model is wrong (or
the API has a defect worth knowing about), and a test here says which.

Only behaviour that exists today is covered: task and project create / patch / delete, task restore,
idempotency keys, ``base_revision``, the list endpoints and the change feed (paging, tombstones,
``cursor_ahead``). Ids are replaced by stable symbols (``$1``, ``$2`` ...) in order of appearance.
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from typing import Any

import pytest
from httpx import AsyncClient

from tests.conftest import create_user_via_setup

from .engine import Req, Resp
from .model import ModelServer
from .real import RealServer

pytestmark = pytest.mark.usefixtures("_db")

KEY_A, KEY_B, KEY_C = (f"00000000-0000-4000-8000-00000000000{n}" for n in (1, 2, 3))


def step(
    method: str, path: str, body: dict | None = None, *, key: str | None = None, **params: Any
) -> tuple:
    return (method, path, body, key, params)


class Recorder:
    """Runs a trace against one server and normalises the answers."""

    def __init__(self, server: Any) -> None:
        self.server = server
        self.symbols: dict[str, str] = {}

    def sym(self, entity_id: str) -> str:
        return self.symbols.setdefault(entity_id, f"${len(self.symbols) + 1}")

    def real_path(self, path: str) -> str:
        for symbol, entity_id in ((v, k) for k, v in self.symbols.items()):
            path = path.replace(symbol + "/", entity_id + "/")
            if path.endswith(symbol):
                path = path[: -len(symbol)] + entity_id
        return path

    async def run(self, trace: Sequence[tuple]) -> list[Any]:
        out: list[Any] = []
        for method, path, body, key, params in trace:
            headers = {"Idempotency-Key": key} if key else {}
            resp = await self.server.handle(
                Req(method, self.real_path(path), params=params, body=body, headers=headers)
            )
            out.append((method, path, resp.status, self.normalise(resp)))
        return out

    def normalise(self, resp: Resp) -> Any:
        body = resp.body
        if not isinstance(body, dict):
            return None
        if "changes" in body:  # the feed
            return {
                "changes": [
                    (c["entity_type"], self.sym(c["entity_id"]), c["operation"], c["cursor"])
                    for c in body["changes"]
                ],
                "next_since": body["next_since"],
                "has_more": body["has_more"],
                "resync_required": body["resync_required"],
                "resync_reason": body.get("resync_reason"),
            }
        for plural in ("tasks", "projects"):
            if plural in body:
                return [self.entity(row) for row in body[plural]]
        if "id" in body:
            return self.entity(body)
        detail = body.get("detail")
        if isinstance(detail, dict) and "current_revision" in detail:
            return {"current_revision": detail["current_revision"]}
        return None

    def entity(self, row: dict[str, Any]) -> dict[str, Any]:
        label = "title" if "title" in row else "name"
        return {
            "id": self.sym(row["id"]),
            label: row[label],
            "description": row.get("description"),
            "revision": row["revision"],
        }


def _link(trace: list[tuple]) -> list[tuple]:
    return trace


# --- the traces ----------------------------------------------------------------------------

TRACES: dict[str, list[tuple]] = {
    "task lifecycle": [
        step("POST", "/api/tasks", {"title": "One"}),
        step("GET", "/api/tasks/$1"),
        step("PATCH", "/api/tasks/$1", {"title": "Uno", "description": "d"}),
        step(
            "PATCH", "/api/tasks/$1", {"description": "d"}
        ),  # a no-op patch still bumps the revision
        step("DELETE", "/api/tasks/$1"),
        step("GET", "/api/tasks/$1"),
        step("PATCH", "/api/tasks/$1", {"title": "late"}),
        step("DELETE", "/api/tasks/$1"),
        step("POST", "/api/tasks/$1/restore"),
        step("POST", "/api/tasks/$1/restore"),  # not deleted any more
        step("GET", "/api/tasks"),
        step("GET", "/api/changes"),
    ],
    "project lifecycle": [
        step("POST", "/api/projects", {"name": "P"}),
        step("PATCH", "/api/projects/$1", {"description": "x"}),
        step("GET", "/api/projects"),
        step("DELETE", "/api/projects/$1"),
        step("GET", "/api/projects"),
        step("PATCH", "/api/projects/$1", {"name": "Q"}),
        step("DELETE", "/api/projects/$1"),
        step("POST", "/api/projects/$1/restore"),  # there is no project restore endpoint
        step("GET", "/api/changes"),
    ],
    "validation": [
        step("POST", "/api/tasks", {"description": "no title"}),
        step("POST", "/api/tasks", {"title": ""}),
        step("POST", "/api/projects", {}),
        step("PATCH", "/api/tasks/00000000-0000-4000-8000-0000000000aa", {"title": "x"}),
        step("GET", "/api/changes"),
    ],
    "idempotent create and patch": [
        step("POST", "/api/tasks", {"title": "A"}, key=KEY_A),
        step("POST", "/api/tasks", {"title": "A"}, key=KEY_A),  # replay: same entity, nothing new
        step("POST", "/api/tasks", {"title": "B"}, key=KEY_A),  # same key, other body
        step("PATCH", "/api/tasks/$1", {"title": "A2"}, key=KEY_B),
        step("PATCH", "/api/tasks/$1", {"title": "A2"}, key=KEY_B),  # replay: revision stays 2
        step("PATCH", "/api/tasks/$1", {"title": "A3"}, key=KEY_B),  # same key, other body
        step("POST", "/api/projects", {"name": "A"}, key=KEY_B),  # same key, other operation
        step("GET", "/api/tasks"),
        step("GET", "/api/changes"),
    ],
    "replay returns the stored answer even after the entity moved on": [
        step("POST", "/api/tasks", {"title": "A"}),
        step("PATCH", "/api/tasks/$1", {"title": "A2"}, key=KEY_A),
        step("PATCH", "/api/tasks/$1", {"title": "A3"}),
        step("PATCH", "/api/tasks/$1", {"title": "A2"}, key=KEY_A),  # stored revision 2, not 3
        step("DELETE", "/api/tasks/$1", key=KEY_B),
        step("DELETE", "/api/tasks/$1", key=KEY_B),  # replay: 204 again, not 404
        step("DELETE", "/api/tasks/$1"),  # without a key: 404
        step("POST", "/api/tasks/$1/restore", key=KEY_C),
        step("POST", "/api/tasks/$1/restore", key=KEY_C),  # replay: 200 again, not 404
    ],
    "a failed request stores nothing under its key": [
        step("PATCH", "/api/tasks/00000000-0000-4000-8000-0000000000aa", {"title": "x"}, key=KEY_A),
        step("POST", "/api/tasks", {"title": "now valid"}, key=KEY_A),  # the key is still free
        step("GET", "/api/tasks"),
    ],
    "base revision": [
        step("POST", "/api/tasks", {"title": "A"}),
        step("PATCH", "/api/tasks/$1", {"title": "B", "base_revision": 1}),
        step("PATCH", "/api/tasks/$1", {"title": "C", "base_revision": 1}),  # stale: 409
        step("PATCH", "/api/tasks/$1", {"title": "D"}),  # no base: blind overwrite
        step("PATCH", "/api/tasks/$1", {"title": "E", "base_revision": 3}),
        step("GET", "/api/tasks/$1"),
    ],
    "feed paging, tombstones and cursor ahead": [
        step("POST", "/api/tasks", {"title": "A"}),
        step("POST", "/api/projects", {"name": "P"}),
        step("POST", "/api/tasks", {"title": "B"}),
        step("PATCH", "/api/tasks/$1", {"title": "A2"}),  # moves A to the end: one row per entity
        step("DELETE", "/api/tasks/$3"),
        step("GET", "/api/changes"),
        step("GET", "/api/changes", since=0, limit=1),
        step("GET", "/api/changes", since=4, limit=1),
        step("GET", "/api/changes", since=5, limit=2),
        step("GET", "/api/changes", since=5),  # at the head
        step("GET", "/api/changes", since=6),  # cursor ahead
        step("GET", "/api/changes", since=999999),
        step("GET", "/api/changes", since=-1),
        step("GET", "/api/changes", limit=0),
        step("GET", "/api/changes", limit=501),
    ],
}


@pytest.mark.parametrize("name", list(TRACES))
async def test_model_and_real_api_answer_a_trace_identically(
    client: AsyncClient, name: str
) -> None:
    await create_user_via_setup(client)
    real = Recorder(RealServer(client))
    model = Recorder(ModelServer())

    expected = await _run_with_symbols(model, TRACES[name])
    actual = await _run_with_symbols(real, TRACES[name])

    assert len(expected) == len(actual)
    for index, (want, got) in enumerate(zip(expected, actual, strict=True)):
        assert got == want, f"trace '{name}' step {index}: model {want} != real {got}"


async def _run_with_symbols(recorder: Recorder, trace: list[tuple]) -> list[Any]:
    """Run a trace; ``$n`` in a path names the n-th distinct entity id the server has returned."""
    out: list[Any] = []
    for index, one in enumerate(trace):
        out.extend(await recorder.run([one]))
        del index
    return out


async def test_the_conformance_check_can_fail(client: AsyncClient) -> None:
    """A model with a planted defect no longer matches the real API on the trace that covers it."""
    from .model import ServerBugs

    await create_user_via_setup(client)
    real = Recorder(RealServer(client))
    model = Recorder(ModelServer(ServerBugs(ignore_idempotency=True)))
    expected = await _run_with_symbols(model, TRACES["idempotent create and patch"])
    actual = await _run_with_symbols(real, TRACES["idempotent create and patch"])
    assert expected != actual


# --- real concurrency (cannot be expressed as a sequential trace) ---------------------------


async def _first_task(server: RealServer) -> str:
    created = await server.handle(Req("POST", "/api/tasks", body={"title": "base"}))
    assert created.status == 201
    return str(created.body["id"])


async def test_concurrent_requests_with_one_idempotency_key_create_one_entity(
    client: AsyncClient,
) -> None:
    await create_user_via_setup(client)
    server = RealServer(client)
    headers = {"Idempotency-Key": KEY_A}
    first, second = await asyncio.gather(
        server.handle(Req("POST", "/api/tasks", body={"title": "once"}, headers=headers)),
        server.handle(Req("POST", "/api/tasks", body={"title": "once"}, headers=headers)),
    )
    assert {first.status, second.status} <= {201, 409, 500}
    listing = await server.handle(Req("GET", "/api/tasks"))
    assert [row["title"] for row in listing.body["tasks"]] == ["once"], "exactly one entity"
    assert first.status == 201 or second.status == 201


@pytest.mark.xfail(
    strict=True,
    reason=(
        "FINDING SIM-F1 (SYNC-02): two concurrent PATCHes with the same base_revision can both be "
        "applied; the second silently overwrites the first and both report the same revision. "
        "TasksService.update checks base_revision on an unlocked read (no row lock, no revision "
        "predicate in the UPDATE). Not fixed in SYNC-02 (no behaviour change); belongs to SYNC-03."
    ),
)
async def test_two_concurrent_patches_with_the_same_base_revision_cannot_both_win(
    client: AsyncClient,
) -> None:
    await create_user_via_setup(client)
    server = RealServer(client)
    task_id = await _first_task(server)
    outcomes: set[tuple[int, ...]] = set()
    for attempt in range(8):
        base = (await server.handle(Req("GET", f"/api/tasks/{task_id}"))).body["revision"]
        results = await asyncio.gather(
            server.handle(
                Req(
                    "PATCH",
                    f"/api/tasks/{task_id}",
                    body={"title": f"a{attempt}", "base_revision": base},
                )
            ),
            server.handle(
                Req(
                    "PATCH",
                    f"/api/tasks/{task_id}",
                    body={"title": f"b{attempt}", "base_revision": base},
                )
            ),
        )
        outcomes.add(tuple(sorted(r.status for r in results)))
        revisions = sorted(r.body.get("revision", 0) for r in results if r.status == 200)
        assert len(revisions) < 2 or revisions[0] != revisions[1], (
            f"both patches succeeded and report revision {revisions[0]} for different states"
        )
    assert outcomes == {(200, 409)}, f"observed status pairs: {sorted(outcomes)}"
