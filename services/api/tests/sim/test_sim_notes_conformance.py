"""Model/real conformance for notes (SYNC-04, layer C of TESTING.md section 10).

The same sequential traces (client ids, history, three-way merge, conflict copies, edit-wins,
revive, move, portable paths, replay with content, the note rows of the feed) run against the
in-memory model server and the real FastAPI application on PostgreSQL with a per-test notes folder;
the normalised answers must be identical. The model is what the note simulation runs thousands of
seeds on, so wherever it differs from the real API the model is wrong.

Conflict copies are named with the server clock; the stamp is replaced before comparing.
"""

from __future__ import annotations

from typing import Any

import pytest
from httpx import AsyncClient

from tests.conftest import create_user_via_setup

from .engine import Resp
from .model import ModelServer, ServerBugs
from .model_notes import sha, strip_stamp
from .real import RealServer
from .test_sim_conformance import KEY_A, KEY_B, KEY_C, Recorder, sync_step

pytestmark = pytest.mark.usefixtures("_db")

N1, N2, N3, N4 = (f"00000000-0000-4000-8000-0000000000c{n}" for n in range(1, 5))
KEYS = [f"00000000-0000-4000-8000-00000000010{n}" for n in range(10)] + [
    f"00000000-0000-4000-8000-00000000011{n}" for n in range(10)
]
TEXT = "# Title\n\nalpha\n\nbeta\n\ngamma\n\ndelta\n\nepsilon\n"


def put(note: str, content: str, base: int, base_text: str, key: str, **extra: Any) -> tuple:
    body = {"content": content, "base_revision": base, "base_hash": sha(base_text), **extra}
    return sync_step("PUT", f"/api/notes/{note}", body, key=key)


def create(note: str, path: str, content: str, key: str) -> tuple:
    return sync_step("POST", "/api/notes", {"id": note, "path": path, "content": content}, key=key)


def delete(note: str, base: int, key: str) -> tuple:
    return sync_step("DELETE", f"/api/notes/{note}", key=key, base_revision=base)


def move(note: str, path: str, base: int, key: str) -> tuple:
    return sync_step(
        "POST", f"/api/notes/{note}/move", {"path": path, "base_revision": base}, key=key
    )


class NoteRecorder(Recorder):
    """Normalises note answers (ids to symbols, the copy's clock stamp removed)."""

    def note(self, row: dict[str, Any]) -> dict[str, Any]:
        out: dict[str, Any] = {
            "id": self.sym(row["id"]),
            "path": strip_stamp(row["path"]),
            "revision": row["revision"],
            "content_hash": row["content_hash"],
            "size_bytes": row["size_bytes"],
            "content": row.get("content", "<absent>"),
        }
        if row.get("sync") is not None:
            sync = row["sync"]
            out["sync"] = (
                sync["revision"],
                [(r["rule"], r.get("kept_revision")) for r in sync["resolution"]],
                sync["conflicts"],
                sync["merged"],
            )
        return out

    def normalise(self, resp: Resp) -> Any:
        body = resp.body
        if not isinstance(body, dict):
            return None
        if "notes" in body:
            return [self.note({**n, "content": "-"}) for n in body["notes"]]
        if "revisions" in body:
            return [
                (r["revision"], r["content_hash"], r["path"], r["available"])
                for r in body["revisions"]
            ]
        if "changes" in body:
            items = []
            for change in body["changes"]:
                data = change.get("data")
                item = (
                    change["entity_type"],
                    self.sym(change["entity_id"]),
                    change["operation"],
                    change["cursor"],
                )
                if data is not None:
                    item += (
                        change.get("revision"),
                        data["deleted_at"] is not None,
                        strip_stamp(data["path"]),
                        data["content_hash"],
                    )
                items.append(item)
            return {
                "changes": items,
                "next_since": body["next_since"],
                "has_more": body["has_more"],
                "head": body["head"],
            }
        if "error" in body:
            copy = body.get("conflict_copy")
            return {
                "error": body["error"],
                "reason": body.get("reason"),
                "fields": body.get("fields"),
                "current_revision": body.get("current_revision"),
                "current_hash": body.get("current_hash"),
                "conflicts": body.get("conflicts"),
                "conflict_copy": None
                if copy is None
                else {
                    "id": self.sym(copy["id"]),
                    "path": strip_stamp(copy["path"]),
                    "revision": copy["revision"],
                    "content_hash": copy["content_hash"],
                },
                "entity": None
                if "entity" not in body
                else {
                    "id": self.sym(body["entity"]["id"]),
                    "path": body["entity"]["path"],
                    "revision": body["entity"]["revision"],
                    "content_hash": body["entity"]["content_hash"],
                },
                "resolution": [r["rule"] for r in body.get("resolution", [])],
                "path_reason": body.get("reason") if body["error"] == "invalid_path" else None,
            }
        if "id" in body and "path" in body:
            if "created_at" in body and "reason" in body:  # a history revision
                return (body["revision"], body["content_hash"], body["path"], body["content"])
            return self.note(body)
        return {"status_only": True, "detail": body.get("detail")}


def keys() -> list[str]:
    return list(KEYS)


K = keys()

TRACES: dict[str, list[tuple]] = {
    "note create, replay and the sync-mode requirements": [
        create(N1, "a.md", TEXT, K[0]),
        create(N1, "a.md", TEXT, K[0]),  # key replay: the content comes back
        create(N1, "a.md", TEXT, K[1]),  # id replay under a new key
        create(N1, "a.md", "other", K[2]),  # id taken by another text
        create(N2, "a.md", "second", K[3]),  # path taken: a.md becomes a (2).md
        create(N3, "A.md", "third", K[4]),  # differs by case only: also taken
        sync_step("POST", "/api/notes", {"path": "nokey.md", "content": "x"}),
        sync_step("POST", "/api/notes", {"path": "x.md", "content": "x", "nope": 1}, key=K[5]),
        sync_step("GET", f"/api/notes/{N1}"),
        sync_step("GET", "/api/notes"),
        put(N1, TEXT + "more\n", 1, TEXT, K[6]),
        put(N1, TEXT + "more\n", 1, TEXT, K[6]),  # replay of a fast-forward write
        sync_step("PUT", f"/api/notes/{N1}", {"content": "x", "base_revision": 2}, key=K[7]),
        sync_step(
            "PUT", f"/api/notes/{N1}", {"content": "x", "base_revision": 2, "base_hash": sha("")}
        ),
        put(N1, "x", 9, TEXT, K[8]),  # a base from the future
        put(N1, "x", 1, TEXT, K[6]),  # key reused with another body
        sync_step("GET", f"/api/notes/{N1}/history"),
        sync_step("GET", f"/api/notes/{N1}/history/1"),
        sync_step("GET", f"/api/notes/{N1}/history/99"),
        sync_step("GET", "/api/changes"),
    ],
    "three-way merge, conflict copies and replay": [
        create(N1, "m.md", TEXT, K[0]),
        put(N1, TEXT.replace("alpha", "ALPHA"), 1, TEXT, K[1]),
        put(N1, TEXT.replace("epsilon", "EPSILON"), 1, TEXT, K[2]),  # merges
        put(N1, TEXT.replace("epsilon", "EPSILON"), 1, TEXT, K[2]),  # its replay, with content
        put(N1, TEXT.replace("alpha", "mine"), 1, TEXT, K[3]),  # overlaps: conflict copy
        put(N1, TEXT.replace("alpha", "mine"), 1, TEXT, K[3]),  # replay: same copy, no new one
        put(N1, TEXT.replace("alpha", "again"), 1, "not the base", K[4]),  # base hash is wrong
        put(N1, TEXT, 1, TEXT, K[5]),  # the client changed nothing
        put(N1, TEXT.replace("alpha", "ALPHA"), 1, TEXT, K[6]),  # already there
        sync_step("GET", "/api/notes"),
        sync_step("GET", f"/api/notes/{N1}/history"),
        sync_step("GET", f"/api/notes/{N1}/history/3"),
        sync_step("GET", "/api/changes", include="data", types="note"),
    ],
    "merge keeps line endings and the final newline": [
        create(N1, "crlf.md", "a\r\n\r\nb\r\n\r\nc", K[0]),
        put(N1, "A\r\n\r\nb\r\n\r\nc", 1, "a\r\n\r\nb\r\n\r\nc", K[1]),
        put(N1, "a\r\n\r\nb\r\n\r\nc\r\n- new", 1, "a\r\n\r\nb\r\n\r\nc", K[2]),
        sync_step("GET", f"/api/notes/{N1}"),
    ],
    "edit wins over delete and revive": [
        create(N1, "d.md", TEXT, K[0]),
        put(N1, TEXT.replace("alpha", "A2"), 1, TEXT, K[1]),
        delete(N1, 1, K[2]),  # stale: refused
        delete(N1, 2, K[3]),
        delete(N1, 2, K[3]),  # replay: 204
        delete(N1, 1, K[4]),  # already deleted: 204
        sync_step("GET", f"/api/notes/{N1}"),
        put(N1, TEXT.replace("epsilon", "E2"), 1, TEXT, K[5]),  # revive with a merge
        sync_step("GET", f"/api/notes/{N1}"),
        delete(N1, 4, K[6]),
        put(N1, TEXT.replace("alpha", "clash"), 1, TEXT, K[7]),  # revive, overlap: copy
        sync_step("GET", "/api/notes"),
        delete("00000000-0000-4000-8000-0000000000aa", 1, K[8]),
        sync_step("GET", "/api/changes"),
    ],
    "revive onto a reused path": [
        create(N1, "r.md", "old\n", K[0]),
        delete(N1, 1, K[1]),
        create(N2, "r.md", "new\n", K[2]),
        put(N1, "old edited\n", 1, "old\n", K[3]),
        sync_step("GET", "/api/notes"),
    ],
    "move, collisions and portable paths": [
        create(N1, "one.md", "1\n", K[0]),
        create(N2, "two.md", "2\n", K[1]),
        move(N1, "Folder/one.md", 1, K[2]),
        move(N1, "Folder/one.md", 1, K[2]),  # replay
        move(N1, "Other/one.md", 1, K[3]),  # stale base, later wins
        move(N1, "two.md", 3, K[4]),  # taken
        move(N1, "TWO.md", 3, K[5]),  # taken by case
        move(N1, "Other/one.md", 3, K[6]),  # same path: nothing to do
        move(N1, "elsewhere.md", 99, K[7]),  # from the future
        move(N1, "CON.md", 3, K[8]),
        move(N1, "a:b.md", 3, K[9]),
        move(N1, "x /y.md", 3, K[10]),
        move(N1, "../out.md", 3, K[11]),
        sync_step("POST", f"/api/notes/{N1}/move", {"path": "z.md"}, key=K[12]),
        create(N3, "NUL.md", "x", K[13]),
        create(N3, "bad?.md", "x", K[14]),
        create(N3, "x" * 241, "x", K[15]),
        delete(N2, 1, K[16]),
        move(N2, "gone.md", 2, K[17]),  # a rename does not revive
        sync_step("GET", "/api/notes"),
        sync_step("GET", f"/api/notes/{N1}/history"),
        sync_step("GET", "/api/changes", include="data", types="note"),
    ],
}


@pytest.mark.parametrize("name", list(TRACES))
async def test_model_and_real_api_answer_a_note_trace_identically(
    notes_client: AsyncClient, name: str
) -> None:
    await create_user_via_setup(notes_client)
    real = NoteRecorder(RealServer(notes_client))
    model = NoteRecorder(ModelServer())
    expected: list[Any] = []
    actual: list[Any] = []
    for one in TRACES[name]:
        expected.extend(await model.run([one]))
        actual.extend(await real.run([one]))
    assert len(expected) == len(actual)
    for index, (want, got) in enumerate(zip(expected, actual, strict=True)):
        assert got == want, (
            f"trace '{name}' step {index} ({want[0]} {want[1]}): model {want} != real {got}"
        )


@pytest.mark.parametrize(
    "bug",
    [
        ServerBugs(notes_overwrite_on_stale=True),
        ServerBugs(notes_merge_drops_ours=True),
        ServerBugs(notes_ignore_path_collisions=True),
        ServerBugs(notes_conflict_not_stored=True),
        ServerBugs(stale_delete_wins=True),
        ServerBugs(no_revive=True),
    ],
    ids=lambda b: next(k for k, v in vars(b).items() if v is True),
)
async def test_the_note_conformance_can_fail(notes_client: AsyncClient, bug: ServerBugs) -> None:
    """A model with a planted defect no longer matches the real API on some trace."""
    await create_user_via_setup(notes_client)
    differs = False
    for name in TRACES:
        real = NoteRecorder(RealServer(notes_client))
        model = NoteRecorder(ModelServer(bug))
        expected: list[Any] = []
        actual: list[Any] = []
        for one in TRACES[name]:
            expected.extend(await model.run([one]))
            actual.extend(await real.run([one]))
        differs = differs or expected != actual
        # the real server keeps its state across traces: start each trace on a clean slate
        await _reset(notes_client)
    assert differs


async def _reset(client: AsyncClient) -> None:
    from sqlalchemy import text

    from atlas.db import session_scope
    from tests.conftest import _TRUNCATE

    async with session_scope() as session:
        await session.execute(text(_TRUNCATE))
    from atlas.api.auth import _login_limiter, _password_limiter

    _login_limiter.reset()
    _password_limiter.reset()
    client.cookies.clear()
    await create_user_via_setup(client)


def test_keys_are_unique() -> None:
    assert len(set(KEYS)) == len(KEYS) and KEY_A and KEY_B and KEY_C
