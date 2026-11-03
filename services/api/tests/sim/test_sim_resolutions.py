"""The resolution log and undo in the simulation (SYNC-05; TESTING.md section 10.0c).

Three layers in one module, like the notes simulation:

- **Conformance**: sequential traces (log, feed entity, list, undo, every refusal) replayed on the
  model server and on the real API; the normalised answers must be identical. This is what lets the
  model stand in for the real server in the soak runs.
- **Simulation**: the clients of ``client_v1`` also pull the ``resolution`` feed entity and undo
  resolutions they see; the invariants of ``runner._check_resolutions`` judge the run, on the model
  (default 100 seeds) and on the real API (default 3 seeds).
- **Planted defects**: one deliberate server defect per invariant must trip the named invariant.
"""

from __future__ import annotations

from typing import Any

import pytest
from httpx import AsyncClient

from tests.conftest import create_user_via_setup

from .engine import Resp
from .model import ModelServer, ServerBugs
from .model_notes import strip_stamp
from .real import RealServer
from .test_sim_conformance import UUID_1, UUID_2, step, sync_step
from .test_sim_notes_conformance import (
    N1,
    N2,
    N3,
    TEXT,
    NoteRecorder,
    create,
    delete,
    move,
    put,
)

pytestmark = pytest.mark.usefixtures("_db")

K = [f"00000000-0000-4000-8000-0000000002{n:02d}" for n in range(60)]


class ResolutionRecorder(NoteRecorder):
    """Normalises task, project, note and resolution answers (ids become symbols). The request
    path decides which family of answers it is."""

    current_path = ""

    async def run(self, trace: Any) -> list[Any]:
        self.current_path = trace[0][1]
        return await super().run(trace)

    def res(self, row: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": self.sym(row["id"]),
            "entity": (row["entity_type"], self.sym(row["entity_id"])),
            "rule": row["rule"],
            "field": row["field"],
            "kept_revision": row["kept_revision"],
            "has_loser": row["has_loser"],
            "loser": row["loser"],
            "detail": row["detail"],
            "undoes": self.sym(row["undoes_id"]) if row["undoes_id"] else None,
            "undone": row["undone_at"] is not None,
            "undone_by": self.sym(row["undone_by"]) if row["undone_by"] else None,
            "undoable": row["undoable"],
            "undo_blocked": row["undo_blocked"],
            "follow_up": row["follow_up"],
        }

    def feed_item(self, change: dict[str, Any]) -> tuple:
        kind = change["entity_type"]
        if kind in ("task", "project"):
            return super(NoteRecorder, self).feed_item(change)
        item = (kind, self.sym(change["entity_id"]), change["operation"], change["cursor"])
        data = change.get("data")
        if data is None:
            return item
        if kind == "resolution":
            return (*item, change.get("revision"), self.res(data))
        return (
            *item,
            change.get("revision"),
            data["deleted_at"] is not None,
            strip_stamp(data["path"]),
            data["content_hash"],
        )

    def note(self, row: dict[str, Any]) -> dict[str, Any]:
        out = super().note(row)
        if row.get("sync") is not None:
            out["resolution_ids"] = [self.sym(r["id"]) for r in row["sync"]["resolution"]]
        return out

    def entity(self, row: dict[str, Any]) -> dict[str, Any]:
        out = super().entity(row)
        if row.get("sync") is not None:
            sync = row["sync"]
            out["sync"] = (
                sync["revision"],
                [
                    (
                        r["rule"],
                        r.get("field"),
                        r.get("kept_revision"),
                        r.get("loser"),
                        self.sym(r["id"]),
                    )
                    for r in sync["resolution"]
                ],
                [(c["field"], c["reason"], c["server_value"]) for c in sync["conflicts"]],
            )
        return out

    def normalise(self, resp: Resp) -> Any:
        body = resp.body
        path = self.current_path
        if not isinstance(body, dict):
            return None
        if path.startswith("/api/sync/resolutions"):
            if "resolutions" in body:
                return {
                    "resolutions": [self.res(r) for r in body["resolutions"]],
                    "more": body["next_cursor"] is not None,
                }
            if "applied" in body:
                return {
                    "applied": body["applied"],
                    "revision": body["revision"],
                    "resolution": self.res(body["resolution"]),
                    "undo": self.res(body["undo"]),
                }
            if "rule" in body:
                return self.res(body)
            if "error" in body:
                return {
                    "error": body["error"],
                    "reason": body.get("reason"),
                    "resolution_id": self.sym(body["resolution_id"])
                    if body.get("resolution_id")
                    else None,
                    "follow_up": body.get("follow_up"),
                    "conflicts": [
                        (c["field"], c["reason"], c["server_revision"], c.get("server_value"))
                        for c in body.get("conflicts", [])
                    ],
                    "resolution": self.res(body["resolution"]) if "resolution" in body else None,
                }
            return {"status_only": True}
        if "changes" in body:
            return {
                "changes": [self.feed_item(c) for c in body["changes"]],
                "next_since": body["next_since"],
                "has_more": body["has_more"],
                "head": body["head"],
            }
        if path.startswith("/api/notes"):
            return super().normalise(resp)
        if "error" in body and "resolution" in body and path.startswith("/api/tasks"):
            return super(NoteRecorder, self).normalise(resp)
        return super(NoteRecorder, self).normalise(resp)


def patch(entity: str, base: int, key: str, **fields: Any) -> tuple:
    return sync_step("PATCH", f"/api/tasks/{entity}", {"base_revision": base, **fields}, key=key)


def undo(resolution: str, key: str) -> tuple:
    return sync_step("POST", f"/api/sync/resolutions/{resolution}/undo", key=key)


TRACES: dict[str, list[tuple]] = {
    "a later-wins is logged, announced, listed and undone": [
        sync_step("POST", "/api/tasks", {"id": UUID_1, "title": "A"}, key=K[0]),
        patch(UUID_1, 1, K[1], priority="low"),
        patch(UUID_1, 1, K[2], priority="high"),  # later wins: $2 = the log entry
        patch(UUID_1, 1, K[2], priority="high"),  # replay: same id, nothing new
        sync_step("GET", "/api/sync/resolutions"),
        sync_step("GET", "/api/sync/resolutions/$2"),
        step("GET", "/api/changes"),  # legacy: no resolution rows, same cursor
        sync_step("GET", "/api/changes"),
        sync_step("GET", "/api/changes", include="data", types="resolution"),
        undo("$2", K[3]),
        undo("$2", K[3]),  # replay of the undo
        undo("$2", K[4]),  # already undone
        sync_step("GET", f"/api/tasks/{UUID_1}"),
        sync_step("GET", "/api/sync/resolutions", limit=1),
        sync_step("GET", "/api/sync/resolutions", rule="undo"),
        sync_step("GET", "/api/changes", since=3, include="data", types="resolution"),
        sync_step("GET", "/api/sync/resolutions", limit=0),
    ],
    "undo refuses to overwrite a newer value and reports why": [
        sync_step("POST", "/api/tasks", {"id": UUID_1, "title": "A"}, key=K[0]),
        patch(UUID_1, 1, K[1], priority="low"),
        patch(UUID_1, 1, K[2], priority="high"),  # $2
        patch(UUID_1, 3, K[3], priority="medium"),  # a newer value
        undo("$2", K[4]),  # changed_since
        sync_step("GET", f"/api/tasks/{UUID_1}"),
        patch(UUID_1, 4, K[5], priority="high"),  # medium -> high again
        patch(UUID_1, 4, K[6], priority="low"),  # later wins over high: $3, loser high
        patch(UUID_1, 5, K[7], priority="low"),  # no change
        undo("$3", K[8]),  # applies: back to high
        undo("$2", K[9]),  # $2's value (low) was replaced long ago
        sync_step("DELETE", f"/api/tasks/{UUID_1}", key=K[10], base_revision=7),
        undo("$2", K[11]),  # the task is deleted
        undo(UUID_2, K[12]),  # unknown id
        sync_step("POST", f"/api/sync/resolutions/{UUID_2}/undo"),  # no key
        sync_step("GET", f"/api/sync/resolutions/{UUID_2}"),
        sync_step("GET", "/api/sync/resolutions"),
    ],
    "kinds that cannot be undone say what to do": [
        sync_step("POST", "/api/tasks", {"id": UUID_1, "title": "A"}, key=K[0]),
        sync_step("DELETE", f"/api/tasks/{UUID_1}", key=K[1], base_revision=1),
        patch(UUID_1, 1, K[2], priority="high"),  # revive: $2 edit_wins_over_delete
        undo("$2", K[3]),
        sync_step("DELETE", f"/api/tasks/{UUID_1}", key=K[4], base_revision=2),  # stale: refused
        sync_step("GET", "/api/sync/resolutions"),
        sync_step("GET", "/api/changes", include="data", types="resolution"),
    ],
    "a project field": [
        sync_step("POST", "/api/projects", {"id": UUID_2, "name": "P"}, key=K[0]),
        sync_step(
            "PATCH",
            f"/api/projects/{UUID_2}",
            {"base_revision": 1, "status": "completed"},
            key=K[1],
        ),
        sync_step(
            "PATCH",
            f"/api/projects/{UUID_2}",
            {"base_revision": 1, "status": "archived"},
            key=K[2],
        ),
        undo("$2", K[3]),
        sync_step("GET", f"/api/projects/{UUID_2}"),
        sync_step("GET", "/api/sync/resolutions"),
    ],
    "notes: merged, collision, moved and undone": [
        create(N1, "a.md", TEXT, K[0]),
        create(N2, "a.md", "second", K[1]),  # path_collision: $2 = the note, $3 = the entry
        put(N1, TEXT.replace("alpha", "ALPHA"), 1, TEXT, K[2]),
        put(N1, TEXT.replace("epsilon", "EPSILON"), 1, TEXT, K[3]),  # note_merged
        move(N1, "b.md", 1, K[4]),  # N1 is at revision 3: a stale move, path unchanged by others
        move(N1, "c.md", 3, K[5]),
        move(N1, "d.md", 3, K[6]),  # based on revision 3, but moved at 5: path_later_wins
        sync_step("GET", "/api/sync/resolutions"),
        sync_step("GET", "/api/changes", include="data", types="resolution"),
        undo("$5", K[7]),  # the note moved again since (b.md -> c.md -> d.md): refused
        undo("$6", K[8]),  # nothing moved it after this one: back to c.md
        create(N3, "b.md", "third", K[9]),  # someone takes the path the first move overwrote
        undo("$5", K[10]),  # the path is c.md again, but b.md is taken
        undo("$4", K[11]),  # a merge is not undoable: the other version is in the history
        undo("$3", K[12]),  # nor is a renamed path
        sync_step("GET", f"/api/notes/{N1}"),
        sync_step("GET", "/api/sync/resolutions", entity_id=N1),
    ],
    "a revive that ends in a conflict is logged and replayed with its ids": [
        create(N1, "ro.md", TEXT, K[0]),
        put(N1, TEXT.replace("beta", "BETA"), 1, TEXT, K[1]),
        delete(N1, 2, K[2]),
        put(N1, TEXT.replace("beta", "mine"), 1, TEXT, K[3]),  # revive, then overlap: 409
        put(N1, TEXT.replace("beta", "mine"), 1, TEXT, K[3]),  # replay: the same ids
        sync_step("GET", "/api/sync/resolutions"),
        sync_step("GET", "/api/changes", types="resolution,note"),
    ],
}


async def _run(recorder: ResolutionRecorder, trace: list[tuple]) -> list[Any]:
    out: list[Any] = []
    for one in trace:
        out.extend(await recorder.run([one]))
    return out


@pytest.mark.parametrize("name", list(TRACES))
async def test_model_and_real_api_answer_a_resolution_trace_identically(
    notes_client: AsyncClient, name: str
) -> None:
    await create_user_via_setup(notes_client)
    real = ResolutionRecorder(RealServer(notes_client))
    model = ResolutionRecorder(ModelServer())
    expected = await _run(model, TRACES[name])
    actual = await _run(real, TRACES[name])
    assert len(expected) == len(actual)
    for index, (want, got) in enumerate(zip(expected, actual, strict=True)):
        assert got == want, f"trace '{name}' step {index}: model {want} != real {got}"


_FIRST = "a later-wins is logged, announced, listed and undone"
_SECOND = "undo refuses to overwrite a newer value and reports why"


@pytest.mark.parametrize(
    ("bugs", "trace"),
    [
        pytest.param(ServerBugs(res_not_announced=True), _FIRST, id="not announced"),
        pytest.param(ServerBugs(res_not_logged=True), _SECOND, id="not logged"),
        pytest.param(ServerBugs(undo_ignores_newer_change=True), _SECOND, id="newer overwritten"),
        pytest.param(ServerBugs(undo_twice=True), _FIRST, id="undone twice"),
    ],
)
async def test_the_resolution_conformance_check_can_fail(
    notes_client: AsyncClient, bugs: ServerBugs, trace: str
) -> None:
    """A model with a planted defect no longer matches the real API on the trace that covers it."""
    await create_user_via_setup(notes_client)
    real = await _run(ResolutionRecorder(RealServer(notes_client)), TRACES[trace])
    model = await _run(ResolutionRecorder(ModelServer(bugs)), TRACES[trace])
    assert model != real
