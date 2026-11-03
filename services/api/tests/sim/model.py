"""In-memory model of today's task/project/feed/idempotency semantics (SYNC-02).

This mirrors what the real API does *now* (SYNC_PROTOCOL.md §2, verified against the code and by
``test_sim_conformance.py`` which replays identical traces against both): server-assigned ids,
per-entity ``revision`` (+1 on every successful write, even a no-op patch), soft delete, ``404`` for
a read/patch/delete of a deleted entity, ``409`` for a stale ``base_revision``, idempotency keys
whose *successful* response is stored and replayed (failed requests store nothing), and the cursor
feed (one row per entity at its latest cursor, ``cursor_ahead`` / ``below_floor`` resync signals).

It also records a ground-truth ``history`` of every applied mutation (with the client's operation
id, taken from the ``X-Sim-Op`` header, which the real server ignores). The invariants read it.

:class:`ServerBugs` plants one deliberate defect per flag. Each flag exists so a test can prove that
the matching invariant really fails when the property is violated (a harness that cannot fail
proves nothing).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from .engine import Req, Resp

#: label field per kind (task ``title``, project ``name``); both also have ``description``.
LABEL = {"task": "title", "project": "name"}
_PLURAL = {"task": "tasks", "project": "projects"}
_KIND_OF = {"tasks": "task", "projects": "project"}


@dataclass
class ServerBugs:
    #: never reserve idempotency keys: a retried create makes a second entity
    ignore_idempotency: bool = False
    #: every 4th patch is acknowledged (200 + body) but not applied
    ack_but_drop_write: bool = False
    #: a patch carrying an older ``X-Client-Time`` than the entity's last is silently ignored
    lww_by_client_time: bool = False
    #: every 4th mutation is not recorded on the feed
    skip_feed_row: bool = False
    #: patching a deleted entity brings it back instead of ``404``
    resurrect_on_stale_patch: bool = False
    #: when a page has more, ``next_since`` overshoots by one: the next row is never delivered
    feed_cursor_skips: bool = False


@dataclass
class Entity:
    kind: str
    id: str
    fields: dict[str, Any]
    revision: int = 1
    deleted: bool = False
    last_client_time: int = -(10**18)


@dataclass
class HistoryEvent:
    op_id: str
    event: str  # create | patch | delete | restore | resurrect
    kind: str
    entity_id: str
    revision: int


@dataclass
class FeedRow:
    seq: int
    kind: str
    entity_id: str
    operation: str
    revision: int  # the entity revision when the row was written (for the cursor-safety check)


class ModelServer:
    def __init__(self, bugs: ServerBugs | None = None) -> None:
        self.bugs = bugs or ServerBugs()
        self.entities: dict[str, Entity] = {}
        self.feed: dict[tuple[str, str], FeedRow] = {}
        self.head_seq = 0
        self.floor = 0
        self.idem: dict[str, tuple[str, str, int, Any]] = {}
        self.history: list[HistoryEvent] = []
        self._next_id = 0
        self._mutations = 0
        self._patches = 0

    # --- ServerPort -------------------------------------------------------------------------

    async def head(self) -> int:
        return self.head_seq

    async def handle(self, req: Req) -> Resp:
        parts = [p for p in req.path.split("/") if p]  # api, <plural>, [id], [restore]
        if parts[:2] == ["api", "changes"] and req.method == "GET":
            return self._changes(req)
        if len(parts) < 2 or parts[0] != "api" or parts[1] not in _KIND_OF:
            return Resp(404, {"detail": "Not Found"})
        kind = _KIND_OF[parts[1]]
        rest = parts[2:]
        if not rest:
            if req.method == "POST":
                return self._idempotent(
                    req, f"{kind}.create", {**(req.body or {})}, self._create, kind
                )
            if req.method == "GET":
                live = [e for e in self.entities.values() if e.kind == kind and not e.deleted]
                return Resp(200, {parts[1]: [self._out(e) for e in live]})
        elif len(rest) == 1:
            entity_id = rest[0]
            if req.method == "GET":
                entity = self._live(kind, entity_id)
                return (
                    Resp(200, self._out(entity)) if entity else Resp(404, {"detail": "Not found"})
                )
            if req.method == "PATCH":
                payload = {"id": entity_id, **(req.body or {})}
                return self._idempotent(
                    req, f"{kind}.update", payload, self._patch, kind, entity_id
                )
            if req.method == "DELETE":
                return self._idempotent(
                    req, f"{kind}.delete", {"id": entity_id}, self._delete, kind, entity_id
                )
        elif len(rest) == 2 and rest[1] == "restore" and kind == "task" and req.method == "POST":
            return self._idempotent(
                req, "task.restore", {"id": rest[0]}, self._restore, kind, rest[0]
            )
        return Resp(404, {"detail": "Not Found"})

    # --- idempotency ------------------------------------------------------------------------

    def _idempotent(self, req: Req, operation: str, payload: dict, fn: Any, *args: Any) -> Resp:
        key = req.headers.get("Idempotency-Key")
        fingerprint = json.dumps(payload, sort_keys=True, default=str)
        if key and not self.bugs.ignore_idempotency:
            stored = self.idem.get(key)
            if stored is not None:
                if stored[0] != operation or stored[1] != fingerprint:
                    return Resp(409, {"detail": "idempotency key reused with a different request"})
                return Resp(stored[2], stored[3])  # replay: nothing is applied again
        resp: Resp = fn(req, *args)
        if key and not self.bugs.ignore_idempotency and 200 <= resp.status < 300:
            self.idem[key] = (operation, fingerprint, resp.status, resp.body)
        return resp

    # --- mutations --------------------------------------------------------------------------

    def _create(self, req: Req, kind: str) -> Resp:
        body = req.body or {}
        label = body.get(LABEL[kind])
        if not isinstance(label, str) or not label:
            return Resp(422, {"detail": "validation"})
        self._next_id += 1
        entity = Entity(
            kind, f"e{self._next_id}", {LABEL[kind]: label, "description": body.get("description")}
        )
        self.entities[entity.id] = entity
        self._record(entity, "upsert")
        self._history(req, "create", entity)
        return Resp(201, self._out(entity))

    def _patch(self, req: Req, kind: str, entity_id: str) -> Resp:
        entity = self.entities.get(entity_id)
        if entity is None or entity.kind != kind:
            return Resp(404, {"detail": "Not found"})
        if entity.deleted and not self.bugs.resurrect_on_stale_patch:
            return Resp(404, {"detail": "Not found"})
        body = dict(req.body or {})
        base = body.pop("base_revision", None)
        if base is not None and base != entity.revision:
            return Resp(
                409, {"detail": {"message": "changed", "current_revision": entity.revision}}
            )
        self._patches += 1
        client_time = int(req.headers.get("X-Client-Time", "0"))
        dropped = (self.bugs.ack_but_drop_write and self._patches % 4 == 0) or (
            self.bugs.lww_by_client_time and client_time < entity.last_client_time
        )
        if dropped:
            return Resp(200, self._out(entity))  # acknowledged, never applied
        revived = entity.deleted
        entity.deleted = False
        for name in (LABEL[kind], "description"):
            if name in body:
                entity.fields[name] = body[name]
        entity.revision += 1
        entity.last_client_time = max(entity.last_client_time, client_time)
        self._record(entity, "upsert")
        self._history(req, "resurrect" if revived else "patch", entity)
        return Resp(200, self._out(entity))

    def _delete(self, req: Req, kind: str, entity_id: str) -> Resp:
        entity = self._live(kind, entity_id)
        if entity is None:
            return Resp(404, {"detail": "Not found"})
        entity.deleted = True
        entity.revision += 1
        self._record(entity, "delete")
        self._history(req, "delete", entity)
        return Resp(204, None)

    def _restore(self, req: Req, kind: str, entity_id: str) -> Resp:
        entity = self.entities.get(entity_id)
        if entity is None or entity.kind != kind or not entity.deleted:
            return Resp(404, {"detail": "Not found"})
        entity.deleted = False
        entity.revision += 1
        self._record(entity, "upsert")
        self._history(req, "restore", entity)
        return Resp(200, self._out(entity))

    # --- feed -------------------------------------------------------------------------------

    def _record(self, entity: Entity, operation: str) -> None:
        self._mutations += 1
        if self.bugs.skip_feed_row and self._mutations % 4 == 0:
            return
        self.head_seq += 1
        self.feed[(entity.kind, entity.id)] = FeedRow(
            self.head_seq, entity.kind, entity.id, operation, entity.revision
        )

    def _history(self, req: Req, event: str, entity: Entity) -> None:
        self.history.append(
            HistoryEvent(
                req.headers.get("X-Sim-Op", "?"), event, entity.kind, entity.id, entity.revision
            )
        )

    def _changes(self, req: Req) -> Resp:
        raw_since, raw_limit = req.params.get("since"), req.params.get("limit")
        since = 0 if raw_since is None else int(raw_since)
        limit = 200 if raw_limit is None else int(raw_limit)
        if since < 0 or since > 2**63 - 1 or limit < 1 or limit > 500:
            return Resp(422, {"detail": "out of range"})
        base = {
            "changes": [],
            "since": since,
            "has_more": False,
            "resync_required": False,
            "resync_reason": None,
        }
        if since > self.head_seq:
            return Resp(
                200,
                {
                    **base,
                    "next_since": self.head_seq,
                    "resync_required": True,
                    "resync_reason": "cursor_ahead",
                },
            )
        if since < self.floor:
            return Resp(
                200,
                {
                    **base,
                    "next_since": max(self.head_seq, self.floor),
                    "resync_required": True,
                    "resync_reason": "below_floor",
                },
            )
        rows = sorted((r for r in self.feed.values() if r.seq > since), key=lambda r: r.seq)
        page = rows[:limit]
        has_more = len(rows) > limit
        next_since = page[-1].seq if page else since
        if has_more and self.bugs.feed_cursor_skips:
            next_since += 1
        items = [
            {
                "entity_type": r.kind,
                "entity_id": r.entity_id,
                "operation": r.operation,
                "cursor": r.seq,
            }
            for r in page
        ]
        return Resp(200, {**base, "changes": items, "next_since": next_since, "has_more": has_more})

    def purge(self, upto: int) -> None:
        """Retention purge as the real job does it: every row at or below ``upto`` goes (M7-02)."""
        upto = min(upto, self.head_seq)
        self.feed = {k: r for k, r in self.feed.items() if r.seq > upto}
        self.floor = max(self.floor, upto)

    def restore_from(self, snapshot: ModelServer) -> None:
        """Replace this server's state by an older snapshot (a backup restore)."""
        for name in ("entities", "feed", "head_seq", "floor", "idem", "history"):
            setattr(self, name, getattr(snapshot, name))

    def snapshot(self) -> ModelServer:
        import copy

        clone = ModelServer(self.bugs)
        for name in ("entities", "feed", "idem", "history"):
            setattr(clone, name, copy.deepcopy(getattr(self, name)))
        clone.head_seq, clone.floor = self.head_seq, self.floor
        clone._next_id, clone._mutations, clone._patches = (
            self._next_id,
            self._mutations,
            self._patches,
        )
        return clone

    # --- helpers ----------------------------------------------------------------------------

    def _live(self, kind: str, entity_id: str) -> Entity | None:
        entity = self.entities.get(entity_id)
        return entity if entity and entity.kind == kind and not entity.deleted else None

    @staticmethod
    def _out(entity: Entity) -> dict[str, Any]:
        return {"id": entity.id, "revision": entity.revision, **entity.fields}

    def canonical(self) -> dict[str, tuple]:
        """Final state keyed by entity id, for comparing runs (clock-independence)."""
        return {
            e.id: (
                e.kind,
                tuple(sorted((k, str(v)) for k, v in e.fields.items())),
                e.revision,
                e.deleted,
            )
            for e in self.entities.values()
        }
