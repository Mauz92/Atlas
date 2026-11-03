"""The model server's resolution log and undo (SYNC-05), as ``SYNC_PROTOCOL.md`` section 9.

The log lives on :class:`~tests.sim.model.ModelServer` (``res_log``) so that snapshots and restores
carry it exactly as a database restore carries the table. This module holds the rules: what a
write logs, how an entry is announced on the feed, and the strict undo. The undoability policy is
the production pure function ``undo_status`` (tested by ``tests/unit/test_resolution_rules.py``);
what the simulation tests is the protocol around it: transactions, retries, ordering, newer
changes, deletes and restores.

``ServerBugs`` plants one defect per invariant (``res_*`` and ``undo_*`` flags).
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

from atlas.sync.resolution_rules import (
    EDIT_WINS_OVER_DELETE,
    NOTE_MERGED,
    PATH_COLLISION,
    PATH_LATER_WINS,
    SIMPLE_LATER_WINS,
    UNDO,
    undo_status,
)

from .engine import Req, Resp

if TYPE_CHECKING:
    from .model import Entity, ModelServer

_REVISION_RULES = frozenset({EDIT_WINS_OVER_DELETE, PATH_COLLISION})
_LOSER_RULES = frozenset({SIMPLE_LATER_WINS, PATH_LATER_WINS})
UNDONE = "undone"  # the model's stand-in for a timestamp


def _error(status: int, code: str, **extra: Any) -> Resp:
    return Resp(status, {"error": code, **extra})


def wire(entry: dict[str, Any]) -> dict[str, Any]:
    """An entry as the API shows it (the list, the feed ``data`` and the undo answer)."""
    status = undo_status(
        rule=entry["rule"],
        entity_type=entry["entity_type"],
        entity_id=entry["entity_id"],
        kept_revision=entry["kept_revision"],
        field=entry["field"],
        has_loser=entry["has_loser"],
        undone=entry["undone_at"] is not None,
    )
    return {
        **{k: v for k, v in entry.items() if not k.startswith("_")},
        "undoable": status.undoable,
        "undo_blocked": status.reason,
        "follow_up": (
            {"kind": status.follow_up.kind, "href": status.follow_up.href}
            if status.follow_up
            else None
        ),
    }


class ModelResolutions:
    def __init__(self, server: ModelServer) -> None:
        self.srv = server

    # --- writing the log ------------------------------------------------------------------------

    def log(
        self,
        req: Req,
        entity: Entity,
        outs: list[dict[str, Any]],
        *,
        revision: int,
        undoes: str | None = None,
    ) -> list[dict[str, Any]]:
        """Log the resolutions of one applied write and put each entry's id into ``outs``.

        Called after the entity's own feed row was recorded (the real server announces the write
        first, then its resolutions, in one transaction).
        """
        srv = self.srv
        key = req.headers.get("Idempotency-Key")
        entries: list[dict[str, Any]] = []
        for ordinal, out in enumerate(outs):
            if out.get("kept_revision") is None and out["rule"] in _REVISION_RULES:
                out["kept_revision"] = revision
            srv._res_n += 1
            rid = f"r{srv._res_n}"
            out["id"] = rid
            srv.generated += 1
            loser = out.get("loser") if out["rule"] in _LOSER_RULES or out["rule"] == UNDO else None
            entry = {
                "id": rid,
                "entity_type": entity.kind,
                "entity_id": entity.id,
                "rule": out["rule"],
                "field": out.get("field"),
                "kept_revision": out.get("kept_revision"),
                "has_loser": out["rule"] in _LOSER_RULES or out["rule"] == UNDO,
                "loser": loser,
                "detail": out.get("detail"),
                "device_id": None,
                "undoes_id": undoes,
                "undone_at": None,
                "undone_by": None,
                "created_at": f"t{srv._res_n}",
                "_op_key": key,
                "_ordinal": ordinal,
                "_op": req.headers.get("X-Sim-Op", "?"),
            }
            if srv.bugs.res_keeps_text and out["rule"] == NOTE_MERGED:
                entry["detail"] = entity.fields["content"]  # BUG: note content in the log
            srv.res_truth[rid] = {
                "op": entry["_op"],
                "entity_id": entity.id,
                "rule": out["rule"],
                "kept_revision": entry["kept_revision"],
            }
            entries.append(entry)
            if srv.bugs.res_not_logged and srv.generated % 3 == 0:
                continue  # BUG: the id is handed out, the row is never written
            srv.res_log.append(entry)
            srv.res_by_id[rid] = entry
            if not srv.bugs.res_not_announced:
                srv._announce("resolution", rid, "upsert", 1)
        return entries

    def replay_hook(self, req: Req, body: Any) -> None:
        """Planted defect: a replayed write logs its resolutions again."""
        if not isinstance(body, dict):
            return
        sync = body.get("sync") or {}
        outs = [dict(o) for o in sync.get("resolution", []) if o.get("rule") != UNDO]
        entity = self.srv.entities.get(body.get("id", ""))
        if outs and entity is not None:
            self.log(req, entity, outs, revision=entity.revision)

    # --- reading --------------------------------------------------------------------------------

    def handle(self, req: Req, rest: list[str]) -> Resp:
        srv = self.srv
        if not rest and req.method == "GET":
            return self._list(req)
        if len(rest) == 1 and req.method == "GET":
            entry = srv.res_by_id.get(rest[0])
            return Resp(200, wire(entry)) if entry else _error(404, "not_found")
        if len(rest) == 2 and rest[1] == "undo" and req.method == "POST":
            return self._undo_entry(req, rest[0])
        return Resp(404, {"detail": "Not Found"})

    def _list(self, req: Req) -> Resp:
        limit = int(req.params.get("limit", 50))
        if limit < 1 or limit > 200:
            return Resp(422, {"detail": "limit"})
        rows = list(reversed(self.srv.res_log))
        if req.params.get("entity_id"):
            rows = [e for e in rows if e["entity_id"] == req.params["entity_id"]]
        if req.params.get("rule"):
            rows = [e for e in rows if e["rule"] == req.params["rule"]]
        start = int(req.params["cursor"]) if req.params.get("cursor") else 0
        page = rows[start : start + limit]
        more = start + limit < len(rows)
        return Resp(
            200,
            {
                "resolutions": [wire(e) for e in page],
                "next_cursor": str(start + limit) if more else None,
            },
        )

    # --- undo -----------------------------------------------------------------------------------

    def _undo_entry(self, req: Req, rid: str) -> Resp:
        srv = self.srv
        key = req.headers.get("Idempotency-Key")
        if not key:
            return _error(422, "idempotency_key_required")
        fingerprint = json.dumps({"resolution_id": rid}, sort_keys=True)
        stored = srv.idem.get(key)
        if stored is not None and not srv.bugs.undo_not_idempotent:
            if stored[0] != "resolution.undo" or stored[1] != fingerprint:
                return _error(409, "idempotency_mismatch")
            return Resp(stored[2], stored[3])
        resp = self._undo(req, rid)
        if 200 <= resp.status < 300:
            srv.idem[key] = ("resolution.undo", fingerprint, resp.status, resp.body)
        return resp

    def _undo(self, req: Req, rid: str) -> Resp:
        srv = self.srv
        res = srv.res_by_id.get(rid)
        if res is None:
            return _error(404, "not_found")
        if res["undone_at"] is not None and not srv.bugs.undo_twice:
            return _error(409, "already_undone", resolution=wire(res))
        verdict = undo_status(
            rule=res["rule"],
            entity_type=res["entity_type"],
            entity_id=res["entity_id"],
            kept_revision=res["kept_revision"],
            field=res["field"],
            has_loser=res["has_loser"],
            undone=False,
        )
        if not verdict.undoable:
            return _error(
                409,
                "not_undoable",
                reason=verdict.reason,
                follow_up=(
                    {"kind": verdict.follow_up.kind, "href": verdict.follow_up.href}
                    if verdict.follow_up
                    else None
                ),
                resolution=wire(res),
            )
        entity = srv.entities.get(res["entity_id"])
        if entity is None:
            return _error(409, "entity_deleted")
        revived = False
        if entity.deleted:
            if not srv.bugs.undo_revives_deleted:
                return _error(409, "entity_deleted")
            revived = True
        if res["rule"] == SIMPLE_LATER_WINS:
            outcome = self._undo_field(req, res, entity, revived)
        else:
            outcome = self._undo_path(req, res, entity)
        if isinstance(outcome, Resp):
            return outcome
        applied, revision, replaced = outcome
        out = {
            "rule": UNDO,
            "field": res["field"],
            "kept_revision": revision,
            "loser": replaced,
        }
        entries: list[dict[str, Any]] = []
        if not srv.bugs.undo_not_logged:
            entries = self.log(req, entity, [out], revision=revision, undoes=res["id"])
        if entries:
            res["undone_at"], res["undone_by"] = UNDONE, entries[0]["id"]
            srv._announce("resolution", res["id"], "upsert", 2)
        undo_wire = wire(entries[0]) if entries else {**out, "id": None}
        return Resp(
            200,
            {"applied": applied, "revision": revision, "resolution": wire(res), "undo": undo_wire},
        )

    def _undo_field(
        self, req: Req, res: dict[str, Any], entity: Entity, revived: bool
    ) -> Resp | tuple[bool, int, Any]:
        srv = self.srv
        name, loser = res["field"], res["loser"]
        changed_at = entity.field_revs.get(name, entity.revision)
        current = entity.fields[name]
        if current == loser:
            return False, entity.revision, current
        if changed_at > res["kept_revision"] and not srv.bugs.undo_ignores_newer_change:
            return _error(
                409,
                "conflict",
                resolution_id=res["id"],
                conflicts=[
                    {
                        "field": name,
                        "reason": "changed_since",
                        "server_revision": changed_at,
                        "server_value": current,
                    }
                ],
            )
        before = entity.revision
        entity.revision += 1
        entity.deleted = False
        entity.fields[name] = loser
        entity.field_revs[name] = entity.revision
        srv._record(entity, "upsert")
        srv._history(
            req,
            "resurrect" if revived else "undo",
            entity,
            base=res["kept_revision"],
            revision_before=before,
            writes=((name, changed_at, False),),
        )
        srv.undo_truth.append(
            {
                "resolution": res["id"],
                "before": current,
                "field_revision_before": changed_at,
                "kept_revision": res["kept_revision"],
            }
        )
        return True, entity.revision, current

    def _undo_path(
        self, req: Req, res: dict[str, Any], entity: Entity
    ) -> Resp | tuple[bool, int, Any]:
        srv = self.srv
        notes = srv.notes
        current_path = entity.fields["path"]
        winner = entity.history.get(res["kept_revision"])
        if (winner is None or winner[1] != current_path) and not srv.bugs.undo_ignores_newer_change:
            return _error(
                409,
                "conflict",
                resolution_id=res["id"],
                conflicts=[
                    {
                        "field": "path",
                        "reason": "changed_since",
                        "server_revision": entity.revision,
                        "server_value": current_path,
                    }
                ],
            )
        target = res["loser"]
        if target == current_path:
            return False, entity.revision, current_path
        if notes._taken(target, exclude=entity.id):
            return _error(409, "path_exists")
        before = entity.revision
        notes._bump(
            entity, entity.fields["content"], target, "move", req.headers.get("X-Sim-Op", "?")
        )
        srv._history(req, "undo", entity, base=before, revision_before=before)
        srv.undo_truth.append(
            {
                "resolution": res["id"],
                "before": current_path,
                "field_revision_before": entity.revision - 1,
                "kept_revision": res["kept_revision"],
                "winner_path": winner[1] if winner else None,
            }
        )
        return True, entity.revision, current_path
