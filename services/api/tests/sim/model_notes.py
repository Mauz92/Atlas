"""The model server's notes (SYNC-04): sync-mode note writes, history, three-way merge, conflict
copies, edit-wins, revive, move and portable paths, as ``SYNC_PROTOCOL.md`` 6.3 specifies them.

It shares the model server's entity table, feed, head and idempotency store (a note is an entity of
kind ``note`` whose fields are ``path`` and ``content``); only the write rules live here. The merge
itself is the production ``merge3`` (established by ``tests/unit/test_note_merge.py``);
what the simulation tests is the protocol around it: bases, history, retries, ordering, deletes and
the invariants of ``TESTING.md`` 10.2 for notes.

:class:`~tests.sim.model.ServerBugs` plants one defect per invariant (``notes_*`` flags).
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import TYPE_CHECKING, Any

from atlas.notes.merge import merge3
from atlas.notes.portable import PortablePathError, check_portable, fold
from atlas.notes.storage import NOTE_SUFFIX, UnsafePathError, normalize_note_path

from .engine import Req, Resp

if TYPE_CHECKING:
    from .model import Entity, ModelServer

#: How many revisions of a note the model keeps (the real server keeps everything younger than 90
#: days up to 200; the simulation's runs are far shorter than that).
HISTORY_KEEP = 200
_COPY_STAMP = "2000-01-01 000000"


def sha(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _error(status: int, code: str, **extra: Any) -> Resp:
    return Resp(status, {"error": code, **extra})


class ModelNotes:
    def __init__(self, server: ModelServer) -> None:
        self.srv = server
        self._copies = 0

    # --- routing ----------------------------------------------------------------------------

    def handle(self, req: Req, sync: bool, rest: list[str]) -> Resp:
        method = req.method
        if not rest:
            if method == "POST":
                return self._sync_only(req, sync, "note.create", self._create)
            if method == "GET":
                live = [e for e in self.srv.entities.values() if e.kind == "note" and not e.deleted]
                live.sort(key=lambda e: e.fields["path"])
                return Resp(200, {"notes": [self._summary(e) for e in live], "folders": []})
        elif len(rest) == 1:
            note_id = rest[0]
            if method == "GET":
                note = self._entity(note_id)
                if note is None or note.deleted:
                    return Resp(404, {"detail": "Not found"})
                return Resp(200, self._out(note))
            if method == "PUT":
                return self._put_entry(req, sync, note_id)
            if method == "DELETE":
                return self._delete_entry(req, sync, note_id)
        elif len(rest) == 2 and rest[1] == "move" and method == "POST":
            return self._move_entry(req, sync, rest[0])
        elif len(rest) == 2 and rest[1] == "history" and method == "GET":
            note = self._entity(rest[0])
            if note is None:
                return Resp(404, {"detail": "Not found"})
            rows = [
                {
                    "revision": revision,
                    "content_hash": sha(content),
                    "size_bytes": len(content.encode()),
                    "path": path,
                    "available": True,
                }
                for revision, (content, path, _reason) in sorted(note.history.items(), reverse=True)
            ]
            return Resp(200, {"revisions": rows})
        elif len(rest) == 3 and rest[1] == "history" and method == "GET":
            note = self._entity(rest[0])
            entry = note.history.get(int(rest[2])) if note is not None else None
            if entry is None:
                return Resp(404, {"detail": "Not found"})
            content, path, reason = entry
            return Resp(
                200,
                {
                    "revision": int(rest[2]),
                    "content_hash": sha(content),
                    "size_bytes": len(content.encode()),
                    "path": path,
                    "reason": reason,
                    "available": True,
                    "content": content,
                },
            )
        return Resp(404, {"detail": "Not Found"})

    def _sync_only(self, req: Req, sync: bool, operation: str, fn: Any) -> Resp:
        if not sync:
            return Resp(500, {"detail": "the model only implements notes in sync mode"})
        if not req.headers.get("Idempotency-Key"):
            return _error(422, "idempotency_key_required")
        return self._keyed(req, operation, {**(req.body or {})}, fn)

    # --- idempotency (stores conflicts too: their copy is a side effect) --------------------

    def _keyed(
        self, req: Req, operation: str, payload: dict[str, Any], fn: Any, *args: Any
    ) -> Resp:
        srv = self.srv
        key = req.headers["Idempotency-Key"]
        fingerprint = json.dumps(payload, sort_keys=True, default=str)
        stored = srv.idem.get(key)
        if stored is not None and not srv.bugs.ignore_idempotency:
            if stored[0] != operation or stored[1] != fingerprint:
                return _error(409, "idempotency_mismatch")
            status, body = stored[2], stored[3]
            if 200 <= status < 300 and isinstance(body, dict) and "content_hash" in body:
                note = self._entity(body["id"])
                entry = note.history.get(body["revision"]) if note is not None else None
                if entry is not None and sha(entry[0]) == body["content_hash"]:
                    body = {**body, "content": entry[0]}
            return Resp(status, body)
        resp: Resp = fn(req, *args)
        stores = 200 <= resp.status < 300 or (
            isinstance(resp.body, dict)
            and resp.body.get("error") == "conflict"
            and not srv.bugs.notes_conflict_not_stored
        )
        if not srv.bugs.ignore_idempotency and stores:
            body = resp.body
            if 200 <= resp.status < 300 and isinstance(body, dict) and "content_hash" in body:
                body = {k: v for k, v in body.items() if k != "content"}  # the summary only
            srv.idem[key] = (operation, fingerprint, resp.status, body)
        return resp

    # --- helpers ----------------------------------------------------------------------------

    def _entity(self, note_id: str) -> Entity | None:
        entity = self.srv.entities.get(note_id)
        return entity if entity is not None and entity.kind == "note" else None

    def _live_paths(self, exclude: str | None = None) -> list[tuple[str, str]]:
        return [
            (e.id, e.fields["path"])
            for e in self.srv.entities.values()
            if e.kind == "note" and not e.deleted and e.id != exclude
        ]

    def _taken(self, path: str, exclude: str | None = None) -> bool:
        wanted = fold(path)
        if self.srv.bugs.notes_ignore_path_collisions:
            return any(p == path for _i, p in self._live_paths(exclude))
        return any(fold(p) == wanted for _i, p in self._live_paths(exclude))

    def _free_path(self, path: str) -> str:
        stem = path[: -len(NOTE_SUFFIX)]
        for number in range(2, 1000):
            candidate = f"{stem} ({number}){NOTE_SUFFIX}"
            if not self._taken(candidate):
                return candidate
        raise AssertionError("no free path")

    @staticmethod
    def _portable(path: str) -> Resp | None:
        try:
            check_portable(normalize_note_path(path))
        except PortablePathError as exc:
            return _error(422, "invalid_path", detail=exc.detail, reason=exc.reason)
        except UnsafePathError as exc:
            return Resp(400, {"detail": str(exc)})
        return None

    def _bump(self, note: Entity, content: str, path: str, reason: str, op: str) -> None:
        """The next revision of ``note``: state, history, feed row."""
        srv = self.srv
        note.revision += 1
        note.fields["content"], note.fields["path"] = content, path
        history = note.history
        history[note.revision] = (content, path, reason)
        while len(history) > HISTORY_KEEP:
            del history[min(history)]
        srv._record(note, "upsert")

    def _summary(self, note: Entity) -> dict[str, Any]:
        content = note.fields["content"]
        return {
            "id": note.id,
            "path": note.fields["path"],
            "revision": note.revision,
            "content_hash": sha(content),
            "size_bytes": len(content.encode()),
        }

    def _out(
        self,
        note: Entity,
        *,
        sync: bool = False,
        merged: bool = False,
        resolutions: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        out = {**self._summary(note), "content": note.fields["content"]}
        if sync:
            out["sync"] = {
                "revision": note.revision,
                "resolution": resolutions or [],
                "conflicts": [],
                "merged": merged,
            }
        return out

    @staticmethod
    def _res(rule: str, *, kept: int | None = None, detail: str | None = None) -> dict[str, Any]:
        return {"rule": rule, "field": None, "kept_revision": kept, "loser": None, "detail": detail}

    def _history_event(self, req: Req, event: str, note: Entity, **extra: Any) -> None:
        from .model import HistoryEvent

        op_id = req.headers.get("X-Sim-Op", "?")
        self.srv.history.append(
            HistoryEvent(
                op_id + ":copy" if event == "conflict_copy" and op_id != "?" else op_id,
                event,
                "note",
                note.id,
                note.revision,
                base=extra.pop("base", None),
                revision_before=extra.pop("revision_before", None),
                extra=extra,
            )
        )

    # --- create -----------------------------------------------------------------------------

    def _create(self, req: Req) -> Resp:
        body = dict(req.body or {})
        unknown = sorted(set(body) - {"id", "path", "content"})
        if unknown:
            return _error(422, "unknown_fields", fields=unknown)
        path, content = body.get("path"), body.get("content", "")
        if not isinstance(path, str) or not path or not isinstance(content, str):
            return Resp(422, {"detail": "validation"})
        client_id = body.get("id")
        if client_id is not None:
            existing = self.srv.entities.get(client_id)
            if existing is not None:
                if existing.kind == "note" and self._same_create(existing, path, content):
                    return Resp(201, self._out(existing, sync=True))
                return _error(409, "id_exists")
        refusal = self._portable(path)
        if refusal is not None:
            return refusal
        normalized = normalize_note_path(path)
        requested: str | None = None
        if self._taken(normalized):
            requested, normalized = normalized, self._free_path(normalized)
        note_id = client_id
        if note_id is None:
            self.srv._next_id += 1
            note_id = f"n{self.srv._next_id}"
        note = self._new_note(note_id, normalized, content)
        self._history_event(req, "create", note, after=content)
        resolutions = []
        if requested is not None:
            resolutions.append(
                self._res("path_collision", detail=f"{requested} was taken; created {normalized}")
            )
        return Resp(201, self._out(note, sync=True, resolutions=resolutions))

    def _new_note(self, note_id: str, path: str, content: str) -> Entity:
        from .model import Entity

        note = Entity("note", note_id, {"path": path, "content": content}, 1)
        note.history[1] = (content, path, "create")
        self.srv.entities[note_id] = note
        self.srv._record(note, "upsert")
        return note

    @staticmethod
    def _same_create(existing: Entity, path: str, content: str) -> bool:
        if existing.deleted or existing.revision != 1 or existing.fields["content"] != content:
            return False
        try:
            wanted = normalize_note_path(path)
        except UnsafePathError:
            return False
        stem = wanted[: -len(NOTE_SUFFIX)]
        have = existing.fields["path"]
        return have == wanted or (have.startswith(f"{stem} (") and have.endswith(f"){NOTE_SUFFIX}"))

    # --- update (the three-way merge) --------------------------------------------------------

    def _put_entry(self, req: Req, sync: bool, note_id: str) -> Resp:
        if not sync:
            return Resp(500, {"detail": "the model only implements notes in sync mode"})
        if not req.headers.get("Idempotency-Key"):
            return _error(422, "idempotency_key_required")
        body = dict(req.body or {})
        if body.get("base_hash") is None:
            return _error(422, "base_hash_required")
        unknown = sorted(set(body) - {"content", "base_revision", "base_hash"})
        if unknown:
            return _error(422, "unknown_fields", fields=unknown)
        payload = {"note_id": note_id, **body}
        return self._keyed(req, "note.update", payload, self._put, note_id)

    def _conflict(self, req: Req, note: Entity, content: str, reason: str) -> Resp:
        self._copies += 1
        stem = note.fields["path"][: -len(NOTE_SUFFIX)]
        suffix = "" if self._copies == 1 else f" {self._copies}"
        path = f"{stem} (conflict {_COPY_STAMP}{suffix}){NOTE_SUFFIX}"
        while self._taken(path):
            self._copies += 1
            path = f"{stem} (conflict {_COPY_STAMP} {self._copies}){NOTE_SUFFIX}"
        self.srv._next_id += 1
        saved = (
            content[: len(content) // 2] if self.srv.bugs.notes_conflict_copy_truncated else content
        )
        copy = self._new_note(f"n{self.srv._next_id}", path, saved)
        self._history_event(req, "conflict_copy", copy, after=content, of=note.id)
        return Resp(
            409,
            {
                "error": "conflict",
                "reason": reason,
                "current_revision": note.revision,
                "current_hash": sha(note.fields["content"]),
                "conflicts": [
                    {
                        "field": "content",
                        "reason": "text_conflict",
                        "server_revision": note.revision,
                        "server_value": None,
                    }
                ],
                "conflict_copy": {
                    "id": copy.id,
                    "path": copy.fields["path"],
                    "revision": copy.revision,
                    "content_hash": sha(content),
                },
                "resolution": [],
            },
        )

    def _history_text(self, note: Entity, revision: int, expect_hash: str) -> str | None:
        entry = note.history.get(revision)
        if entry is None or sha(entry[0]) != expect_hash:
            return None
        return entry[0]

    def _put(self, req: Req, note_id: str) -> Resp:
        srv = self.srv
        body = dict(req.body or {})
        content, base, base_hash = body["content"], int(body["base_revision"]), body["base_hash"]
        note = self._entity(note_id)
        if note is None:
            return _error(404, "not_found")
        if base > note.revision:
            return _error(
                409,
                "stale",
                current_revision=note.revision,
                current_hash=sha(note.fields["content"]),
            )
        if note.deleted:
            return self._revive(req, note, content, base, base_hash)
        current = note.fields["content"]
        before = note.revision
        if base == note.revision:
            if base_hash != sha(current):
                return self._conflict(req, note, content, "base_unavailable")
            if content == current:
                return Resp(200, self._out(note, sync=True))
            if srv.bugs.notes_drop_acknowledged_write and srv._patches % 4 == 3:
                srv._patches += 1
                return Resp(200, self._out(note, sync=True))  # acknowledged, never applied
            srv._patches += 1
            self._bump(
                note, content, note.fields["path"], "write", req.headers.get("X-Sim-Op", "?")
            )
            self._history_event(
                req, "write", note, base=base, revision_before=before, theirs=current, ours=content,
                after=content, base_text=current,
            )  # fmt: skip
            return Resp(200, self._out(note, sync=True))
        base_text = self._history_text(note, base, base_hash)
        if base_text is None:
            return self._conflict(req, note, content, "base_unavailable")
        if content == base_text:
            return Resp(200, self._out(note, sync=True, merged=current != content))
        if srv.bugs.notes_overwrite_on_stale:
            merged_text: str | None = content  # BUG: last write wins
        elif srv.bugs.notes_merge_drops_ours:
            merged_text = current  # BUG: acknowledged but the client's edit is not in the result
        else:
            result = merge3(base_text, current, content)
            merged_text = result.text
            if merged_text is None:
                return self._conflict(req, note, content, result.reason or "overlap")
        resolution = [self._res("note_merged", kept=note.revision)]
        if merged_text == current:
            return Resp(
                200,
                self._out(note, sync=True, merged=content != merged_text, resolutions=resolution),
            )
        self._bump(
            note, merged_text, note.fields["path"], "merge", req.headers.get("X-Sim-Op", "?")
        )
        self._history_event(
            req, "merge", note, base=base, revision_before=before, theirs=current, ours=content,
            after=merged_text, base_text=base_text,
        )  # fmt: skip
        return Resp(
            200,
            self._out(note, sync=True, merged=merged_text != content, resolutions=resolution),
        )

    def _revive(self, req: Req, note: Entity, content: str, base: int, base_hash: str) -> Resp:
        if self.srv.bugs.no_revive:
            return _error(404, "not_found")
        resolutions = [self._res("edit_wins_over_delete")]
        last = self._history_text(note, note.revision, sha(note.fields["content"]))
        text, copy_of = content, None
        if last is not None and base_hash != sha(note.fields["content"]):
            base_text = self._history_text(note, base, base_hash)
            merged = merge3(base_text, last, content) if base_text is not None else None
            if merged is not None and merged.text is not None:
                text = merged.text
                resolutions.append(self._res("note_merged", kept=note.revision))
            else:
                text, copy_of = last, content
        path = note.fields["path"]
        if self._taken(path):
            path = self._free_path(path)
            resolutions.append(
                self._res(
                    "path_collision", detail=f"{note.fields['path']} was taken; restored {path}"
                )
            )
        before = note.revision
        note.deleted = False
        known_base = last if base_hash == sha(note.fields["content"]) else None
        if known_base is None:
            known_base = self._history_text(note, base, base_hash)
        self._bump(note, text, path, "revive", req.headers.get("X-Sim-Op", "?"))
        self._history_event(
            req, "revive", note, base=base, revision_before=before, ours=content, after=text,
            theirs=last, base_text=known_base, copy=copy_of is not None,
        )  # fmt: skip
        if copy_of is not None:
            return self._conflict(req, note, copy_of, "overlap")
        return Resp(
            200, self._out(note, sync=True, merged=text != content, resolutions=resolutions)
        )

    # --- delete -----------------------------------------------------------------------------

    def _delete_entry(self, req: Req, sync: bool, note_id: str) -> Resp:
        if not sync:
            return Resp(500, {"detail": "the model only implements notes in sync mode"})
        if req.params.get("base_revision") is None:
            return _error(422, "base_revision_required")
        if not req.headers.get("Idempotency-Key"):
            return _error(422, "idempotency_key_required")
        return self._keyed(req, "note.delete", {"note_id": note_id}, self._delete, note_id)

    def _delete(self, req: Req, note_id: str) -> Resp:
        note = self._entity(note_id)
        if note is None:
            return _error(404, "not_found")
        if note.deleted:
            return Resp(204, None)
        base = int(req.params["base_revision"])
        if base > note.revision:
            return _error(
                409,
                "stale",
                current_revision=note.revision,
                current_hash=sha(note.fields["content"]),
            )
        if base < note.revision and not self.srv.bugs.stale_delete_wins:
            return _error(
                409,
                "edit_wins",
                current_revision=note.revision,
                entity=self._summary(note),
                resolution=[{"rule": "edit_wins_over_delete"}],
            )
        before = note.revision
        note.deleted = True
        note.revision += 1
        note.history[note.revision] = (note.fields["content"], note.fields["path"], "delete")
        self.srv._record(note, "delete")
        self._history_event(req, "delete", note, base=base, revision_before=before)
        return Resp(204, None)

    # --- move -------------------------------------------------------------------------------

    def _move_entry(self, req: Req, sync: bool, note_id: str) -> Resp:
        if not sync:
            return Resp(500, {"detail": "the model only implements notes in sync mode"})
        body = dict(req.body or {})
        if body.get("base_revision") is None:
            return _error(422, "base_revision_required")
        if not req.headers.get("Idempotency-Key"):
            return _error(422, "idempotency_key_required")
        unknown = sorted(set(body) - {"path", "base_revision"})
        if unknown:
            return _error(422, "unknown_fields", fields=unknown)
        return self._keyed(req, "note.move", {"note_id": note_id, **body}, self._move, note_id)

    def _move(self, req: Req, note_id: str) -> Resp:
        body = dict(req.body or {})
        base = int(body["base_revision"])
        refusal = self._portable(str(body["path"]))
        if refusal is not None:
            return refusal
        note = self._entity(note_id)
        if note is None:
            return _error(404, "not_found")
        if note.deleted:
            return _error(409, "note_deleted")
        if base > note.revision:
            return _error(
                409,
                "stale",
                current_revision=note.revision,
                current_hash=sha(note.fields["content"]),
            )
        normalized = normalize_note_path(str(body["path"]))
        resolutions: list[dict[str, Any]] = []
        if base < note.revision and normalized != note.fields["path"]:
            entry = note.history.get(base)
            if entry is not None and entry[1] != note.fields["path"]:
                resolutions.append(self._res("path_later_wins", kept=note.revision + 1))
        if normalized == note.fields["path"]:
            return Resp(200, self._out(note, sync=True, resolutions=resolutions))
        if self._taken(normalized, exclude=note.id):
            return _error(409, "path_exists")
        before = note.revision
        self._bump(
            note, note.fields["content"], normalized, "move", req.headers.get("X-Sim-Op", "?")
        )
        self._history_event(req, "move", note, base=base, revision_before=before)
        return Resp(200, self._out(note, sync=True, resolutions=resolutions))

    # --- feed data --------------------------------------------------------------------------

    def feed_data(self, note: Entity) -> dict[str, Any]:
        return {
            "id": note.id,
            "revision": note.revision,
            "deleted_at": "deleted" if note.deleted else None,
            "path": note.fields["path"],
            "content_hash": sha(note.fields["content"]),
            "size_bytes": len(note.fields["content"].encode()),
        }


_STAMP = re.compile(r"\(conflict \d{4}-\d\d-\d\d \d{6}( \d+)?\)")


def strip_stamp(path: str) -> str:
    """The server clock is in a conflict copy's name; conformance compares the rest."""
    return _STAMP.sub("(conflict)", path)
