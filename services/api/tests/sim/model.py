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
from dataclasses import dataclass, field
from typing import Any

from .engine import Req, Resp
from .model_notes import ModelNotes

#: label field per kind (task ``title``, project ``name``); both also have ``description``.
LABEL = {"task": "title", "project": "name"}
#: the one *simple* field per kind the simulation edits (task ``priority``, project ``status``)
FLAG = {"task": "priority", "project": "status"}
FLAG_DEFAULT = {"task": "none", "project": "active"}
FLAG_VALUES = {"task": ("low", "medium", "high"), "project": ("active", "completed", "archived")}
#: protocol v1 (SYNC-03): the model mirrors the server's sync mode
PROTOCOL_MIN, PROTOCOL_MAX = 1, 1
_PLURAL = {"task": "tasks", "project": "projects"}
_KIND_OF = {"tasks": "task", "projects": "project"}


def text_fields(kind: str) -> tuple[str, ...]:
    return (LABEL[kind], "description")


def all_fields(kind: str) -> tuple[str, ...]:
    return (LABEL[kind], "description", FLAG[kind])


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
    # --- protocol v1 (sync mode) ---
    #: sync PATCH applies every field whatever changed since the base (lost update of a text field)
    merge_ignores_field_revisions: bool = False
    #: sync DELETE ignores ``base_revision``: a stale delete wins over a newer edit (rule 4)
    stale_delete_wins: bool = False
    #: sync PATCH of a deleted entity is ``404`` instead of reviving it (rule 4)
    no_revive: bool = False
    #: the ``since=0`` snapshot silently omits its first live entity
    snapshot_skips_entity: bool = False
    #: the server accepts any ``Atlas-Sync`` value instead of answering ``426``
    accepts_any_protocol: bool = False
    # --- notes (SYNC-04) ---
    #: a stale note save replaces the note with the incoming text (last write wins, no merge)
    notes_overwrite_on_stale: bool = False
    #: a "merged" save is acknowledged with the server's text: the client's edit is not in it
    notes_merge_drops_ours: bool = False
    #: every 4th fast-forward note save is acknowledged but not applied
    notes_drop_acknowledged_write: bool = False
    #: two notes may take paths that differ only by case or Unicode normalisation
    notes_ignore_path_collisions: bool = False
    #: the conflict copy keeps only the first half of the losing text
    notes_conflict_copy_truncated: bool = False
    #: the answer to a conflict is not stored under the key: a retry saves a second copy
    notes_conflict_not_stored: bool = False


@dataclass
class Entity:
    kind: str
    id: str
    fields: dict[str, Any]
    revision: int = 1
    deleted: bool = False
    last_client_time: int = -(10**18)
    field_revs: dict[str, int] = field(default_factory=dict)
    #: notes: revision -> (content, path, reason), the retained history
    history: dict[int, tuple[str, str, str]] = field(default_factory=dict)


@dataclass
class HistoryEvent:
    op_id: str
    event: str  # create | patch | delete | restore | resurrect | revive
    kind: str
    entity_id: str
    revision: int
    #: sync mode: the client's ``base_revision`` and, per written field, ``(field, revision at
    #: which it had last changed, was-it-equal)``; the invariants of section 10.2 read them
    base: int | None = None
    revision_before: int | None = None
    writes: tuple[tuple[str, int, bool], ...] = ()
    #: notes: the texts involved (``theirs``, ``ours``, ``base_text``, ``after``)
    extra: dict[str, Any] = field(default_factory=dict)


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
        self.notes = ModelNotes(self)

    # --- ServerPort -------------------------------------------------------------------------

    async def head(self) -> int:
        return self.head_seq

    async def all_entity_ids(self) -> list[str]:
        return list(self.entities)

    async def handle(self, req: Req) -> Resp:
        sync = self._protocol(req)
        if isinstance(sync, Resp):
            return sync
        parts = [p for p in req.path.split("/") if p]  # api, <plural>, [id], [restore]
        if parts[:2] == ["api", "changes"] and req.method == "GET":
            return self._changes(req)
        if len(parts) >= 2 and parts[0] == "api" and parts[1] == "notes":
            return self.notes.handle(req, bool(sync), parts[2:])
        if len(parts) < 2 or parts[0] != "api" or parts[1] not in _KIND_OF:
            return Resp(404, {"detail": "Not Found"})
        kind = _KIND_OF[parts[1]]
        rest = parts[2:]
        if not rest:
            if req.method == "POST":
                if sync:
                    return self._sync_create(req, kind)
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
                if sync:
                    return self._sync_patch(req, kind, entity_id)
                payload = {"id": entity_id, **(req.body or {})}
                return self._idempotent(
                    req, f"{kind}.update", payload, self._patch, kind, entity_id
                )
            if req.method == "DELETE":
                if sync:
                    return self._sync_delete(req, kind, entity_id)
                return self._idempotent(
                    req, f"{kind}.delete", {"id": entity_id}, self._delete, kind, entity_id
                )
        elif len(rest) == 2 and rest[1] == "restore" and kind == "task" and req.method == "POST":
            if sync and not req.headers.get("Idempotency-Key"):
                return self._error(422, "idempotency_key_required")
            return self._idempotent(
                req, "task.restore", {"id": rest[0]}, self._restore, kind, rest[0]
            )
        return Resp(404, {"detail": "Not Found"})

    def _protocol(self, req: Req) -> bool | Resp:
        """``Atlas-Sync``: absent -> legacy mode, supported major -> sync mode, else ``426``."""
        raw = req.headers.get("Atlas-Sync")
        if raw is None:
            return False
        text = raw.strip()
        ok = text.isascii() and text.isdigit() and PROTOCOL_MIN <= int(text) <= PROTOCOL_MAX
        if not ok and not self.bugs.accepts_any_protocol:
            return Resp(
                426,
                {
                    "error": "sync_version_unsupported",
                    "min": PROTOCOL_MIN,
                    "max": PROTOCOL_MAX,
                },
            )
        return True

    @staticmethod
    def _error(status: int, code: str, **extra: Any) -> Resp:
        return Resp(status, {"error": code, **extra})

    # --- idempotency ------------------------------------------------------------------------

    def _idempotent(self, req: Req, operation: str, payload: dict, fn: Any, *args: Any) -> Resp:
        key = req.headers.get("Idempotency-Key")
        fingerprint = json.dumps(payload, sort_keys=True, default=str)
        sync = "Atlas-Sync" in req.headers
        if key and not self.bugs.ignore_idempotency:
            stored = self.idem.get(key)
            if stored is not None:
                if stored[0] != operation or stored[1] != fingerprint:
                    if sync:
                        return self._error(409, "idempotency_mismatch")
                    return Resp(409, {"detail": "idempotency key reused with a different request"})
                return Resp(stored[2], stored[3])  # replay: nothing is applied again
        resp: Resp = fn(req, *args)
        if key and not self.bugs.ignore_idempotency and 200 <= resp.status < 300:
            self.idem[key] = (operation, fingerprint, resp.status, resp.body)
        return resp

    # --- mutations (default mode) ------------------------------------------------------------

    def _new_entity(self, kind: str, entity_id: str, label: str, description: Any) -> Entity:
        entity = Entity(
            kind,
            entity_id,
            {LABEL[kind]: label, "description": description, FLAG[kind]: FLAG_DEFAULT[kind]},
        )
        entity.field_revs = dict.fromkeys(all_fields(kind), 1)
        return entity

    def _create(self, req: Req, kind: str) -> Resp:
        body = req.body or {}
        label = body.get(LABEL[kind])
        if not isinstance(label, str) or not label:
            return Resp(422, {"detail": "validation"})
        self._next_id += 1
        entity = self._new_entity(kind, f"e{self._next_id}", label, body.get("description"))
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
        entity.revision += 1
        for name in (LABEL[kind], "description", FLAG[kind]):
            if name in body and entity.fields[name] != body[name]:
                entity.fields[name] = body[name]
                entity.field_revs[name] = entity.revision
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

    # --- mutations (sync mode, protocol v1) --------------------------------------------------

    def _sync_create(self, req: Req, kind: str) -> Resp:
        if not req.headers.get("Idempotency-Key"):
            return self._error(422, "idempotency_key_required")
        body = dict(req.body or {})
        unknown = sorted(set(body) - {"id", *all_fields(kind)})
        if unknown:
            return self._error(422, "unknown_fields", fields=unknown)
        payload = {**body}
        return self._idempotent(req, f"{kind}.create", payload, self._create_with_id, kind)

    def _create_with_id(self, req: Req, kind: str) -> Resp:
        body = dict(req.body or {})
        label = body.get(LABEL[kind])
        if not isinstance(label, str) or not label:
            return Resp(422, {"detail": "validation"})
        client_id = body.get("id")
        if client_id is not None:
            existing = self.entities.get(client_id)
            if existing is not None:
                same = (
                    existing.kind == kind
                    and not existing.deleted
                    and existing.revision == 1
                    and existing.fields[LABEL[kind]] == label
                    and existing.fields["description"] == body.get("description")
                    and existing.fields[FLAG[kind]] == body.get(FLAG[kind], FLAG_DEFAULT[kind])
                )
                if same:
                    return Resp(201, self._out(existing, sync=True))
                return self._error(409, "id_exists")
            entity_id = client_id
        else:
            self._next_id += 1
            entity_id = f"e{self._next_id}"
        entity = self._new_entity(kind, entity_id, label, body.get("description"))
        entity.fields[FLAG[kind]] = body.get(FLAG[kind], FLAG_DEFAULT[kind])
        self.entities[entity.id] = entity
        self._record(entity, "upsert")
        self._history(req, "create", entity)
        return Resp(201, self._out(entity, sync=True))

    def _sync_patch(self, req: Req, kind: str, entity_id: str) -> Resp:
        if not req.headers.get("Idempotency-Key"):
            return self._error(422, "idempotency_key_required")
        body = dict(req.body or {})
        if body.get("base_revision") is None:
            return self._error(422, "base_revision_required")
        unknown = sorted(set(body) - {"base_revision", *all_fields(kind)})
        if unknown:
            return self._error(422, "unknown_fields", fields=unknown)
        payload = {"id": entity_id, **body}
        return self._idempotent(req, f"{kind}.update", payload, self._merge_patch, kind, entity_id)

    def _merge_patch(self, req: Req, kind: str, entity_id: str) -> Resp:
        entity = self.entities.get(entity_id)
        if entity is None or entity.kind != kind:
            return self._error(404, "not_found")
        if entity.deleted and self.bugs.no_revive:
            return self._error(404, "not_found")
        body = dict(req.body or {})
        base = int(body.pop("base_revision"))
        if base > entity.revision:
            return self._error(409, "stale", current_revision=entity.revision)
        revived = entity.deleted
        applied: dict[str, Any] = {}
        conflicts: list[dict[str, Any]] = []
        resolutions: list[dict[str, Any]] = []
        writes: list[tuple[str, int, bool]] = []
        for name, value in body.items():
            changed_at = entity.field_revs.get(name, entity.revision)
            equal = entity.fields[name] == value
            if self.bugs.merge_ignores_field_revisions or changed_at <= base:
                if not equal:
                    applied[name] = value
                    writes.append((name, changed_at, False))
            elif equal:
                continue
            elif name in text_fields(kind):
                conflicts.append(
                    {
                        "field": name,
                        "reason": "text_conflict",
                        "server_revision": changed_at,
                        "server_value": entity.fields[name],
                    }
                )
            else:
                applied[name] = value
                writes.append((name, changed_at, False))
                resolutions.append(
                    {
                        "rule": "simple_later_wins",
                        "field": name,
                        "kept_revision": entity.revision + 1,
                        "loser": entity.fields[name],
                    }
                )
        if conflicts and not applied and not revived:
            return self._error(
                409, "conflict", current_revision=entity.revision, conflicts=conflicts
            )
        if not applied and not revived:
            return Resp(200, self._out(entity, sync=True, conflicts=conflicts))
        self._patches += 1
        client_time = int(req.headers.get("X-Client-Time", "0"))
        if self.bugs.lww_by_client_time and client_time < entity.last_client_time:
            return Resp(200, self._out(entity, sync=True))  # acknowledged, never applied
        revision_before = entity.revision
        entity.revision += 1
        entity.deleted = False
        for name, value in applied.items():
            entity.fields[name] = value
            entity.field_revs[name] = entity.revision
        entity.last_client_time = max(entity.last_client_time, client_time)
        self._record(entity, "upsert")
        self._history(
            req,
            "revive" if revived else "patch",
            entity,
            base=base,
            revision_before=revision_before,
            writes=tuple(writes),
        )
        if revived:
            resolutions.append({"rule": "edit_wins_over_delete", "field": None})
        return Resp(200, self._out(entity, sync=True, conflicts=conflicts, resolutions=resolutions))

    def _sync_delete(self, req: Req, kind: str, entity_id: str) -> Resp:
        if not req.headers.get("Idempotency-Key"):
            return self._error(422, "idempotency_key_required")
        if req.params.get("base_revision") is None:
            return self._error(422, "base_revision_required")
        return self._idempotent(
            req, f"{kind}.delete", {"id": entity_id}, self._guarded_delete, kind, entity_id
        )

    def _guarded_delete(self, req: Req, kind: str, entity_id: str) -> Resp:
        entity = self.entities.get(entity_id)
        if entity is None or entity.kind != kind:
            return self._error(404, "not_found")
        if entity.deleted:
            return Resp(204, None)  # already deleted: an idempotent no-op
        base = int(req.params["base_revision"])
        if base < entity.revision and not self.bugs.stale_delete_wins:
            return self._error(
                409,
                "edit_wins",
                current_revision=entity.revision,
                entity=self._out(entity, sync=False),
                resolution=[{"rule": "edit_wins_over_delete"}],
            )
        revision_before = entity.revision
        entity.deleted = True
        entity.revision += 1
        self._record(entity, "delete")
        self._history(req, "delete", entity, base=base, revision_before=revision_before)
        return Resp(204, None)

    # --- feed -------------------------------------------------------------------------------

    def _record(self, entity: Entity, operation: str) -> None:
        self._mutations += 1
        if self.bugs.skip_feed_row and self._mutations % 4 == 0:
            return
        self.head_seq += 1
        self.feed[(entity.kind, entity.id)] = FeedRow(
            self.head_seq, entity.kind, entity.id, operation, entity.revision
        )

    def _history(
        self,
        req: Req,
        event: str,
        entity: Entity,
        *,
        base: int | None = None,
        revision_before: int | None = None,
        writes: tuple[tuple[str, int, bool], ...] = (),
    ) -> None:
        self.history.append(
            HistoryEvent(
                req.headers.get("X-Sim-Op", "?"),
                event,
                entity.kind,
                entity.id,
                entity.revision,
                base,
                revision_before,
                writes,
            )
        )

    def _changes(self, req: Req) -> Resp:
        raw_since, raw_limit = req.params.get("since"), req.params.get("limit")
        since = 0 if raw_since is None else int(raw_since)
        limit = 200 if raw_limit is None else int(raw_limit)
        include = req.params.get("include")
        cap = 200 if include == "data" else 500
        if since < 0 or since > 2**63 - 1 or limit < 1 or limit > cap:
            return Resp(422, {"detail": "out of range"})
        wanted_types = req.params.get("types")
        types = set(wanted_types.split(",")) if wanted_types else None
        base = {
            "changes": [],
            "since": since,
            "has_more": False,
            "resync_required": False,
            "resync_reason": None,
            "head": self.head_seq,
            "floor": self.floor,
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
        if 0 < since < self.floor and not req.params.get("snapshot"):
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
        if since == 0:  # a snapshot: a device with no state has no deletion to learn about
            rows = [r for r in rows if r.operation == "upsert"]
            if self.bugs.snapshot_skips_entity and rows:
                rows = rows[1:]
        if types is not None:
            rows = [r for r in rows if r.kind in types]
        page = rows[:limit]
        has_more = len(rows) > limit
        next_since = page[-1].seq if page else since
        if has_more and self.bugs.feed_cursor_skips:
            next_since += 1
        if not has_more:
            next_since = max(next_since, self.head_seq)
        items = []
        for r in page:
            item: dict[str, Any] = {
                "entity_type": r.kind,
                "entity_id": r.entity_id,
                "operation": r.operation,
                "cursor": r.seq,
            }
            if include == "data" and r.kind == "note":
                entity = self.entities[r.entity_id]
                item["revision"] = entity.revision
                item["data"] = self.notes.feed_data(entity)
            elif include == "data":
                entity = self.entities[r.entity_id]
                item["revision"] = entity.revision
                item["data"] = {
                    "id": entity.id,
                    "revision": entity.revision,
                    "field_revisions": dict(entity.field_revs),
                    "deleted_at": "deleted" if entity.deleted else None,
                    **entity.fields,
                }
            items.append(item)
        return Resp(200, {**base, "changes": items, "next_since": next_since, "has_more": has_more})

    def purge(self, upto: int) -> None:
        """Retention purge as the real job does it: the *tombstones* at or below ``upto`` go and
        the floor rises to the highest one removed; upserts are never purged (ADR-0059 D2)."""
        upto = min(upto, self.head_seq)
        gone = [k for k, r in self.feed.items() if r.operation == "delete" and r.seq <= upto]
        if not gone:
            return
        self.floor = max(self.floor, max(self.feed[k].seq for k in gone))
        for key in gone:
            del self.feed[key]

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
        clone.notes._copies = self.notes._copies
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
    def _out(
        entity: Entity,
        *,
        sync: bool = False,
        conflicts: list[dict[str, Any]] | None = None,
        resolutions: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        out: dict[str, Any] = {"id": entity.id, "revision": entity.revision, **entity.fields}
        out["field_revisions"] = dict(entity.field_revs)
        if sync:
            out["sync"] = {
                "revision": entity.revision,
                "resolution": resolutions or [],
                "conflicts": conflicts or [],
            }
        return out

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
