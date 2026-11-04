/** The model server's resolution log and undo (a port of `model_resolutions.py`). */

import { clone, error, stable, type Req, type Resp } from "./common.ts";
import {
  EDIT_WINS_OVER_DELETE,
  PATH_COLLISION,
  PATH_LATER_WINS,
  SIMPLE_LATER_WINS,
  UNDO,
  undoStatus,
} from "./resolutionRules.ts";
import type { Entity, ModelServer } from "./server.ts";

type Entry = Record<string, unknown>;
const REVISION_RULES = new Set([EDIT_WINS_OVER_DELETE, PATH_COLLISION]);
const LOSER_RULES = new Set([SIMPLE_LATER_WINS, PATH_LATER_WINS]);
export const UNDONE = "undone";

/** An entry as the API shows it (the list, the feed `data` and the undo answer). */
export function wire(entry: Entry): Entry {
  const status = undoStatus({
    rule: entry["rule"] as string,
    entityId: entry["entity_id"] as string,
    keptRevision: entry["kept_revision"] as number | null,
    field: entry["field"] as string | null,
    hasLoser: entry["has_loser"] as boolean,
    undone: entry["undone_at"] !== null,
  });
  const visible = Object.fromEntries(Object.entries(entry).filter(([k]) => !k.startsWith("_")));
  return {
    ...visible,
    undoable: status.undoable,
    undo_blocked: status.reason,
    follow_up: status.followUp,
  };
}

export class ModelResolutions {
  constructor(private readonly srv: ModelServer) {}

  /** Log the resolutions of one applied write and put each entry's id into `outs`. */
  log(req: Req, entity: Entity, outs: Entry[], opts: { revision: number; undoes?: string | null }): Entry[] {
    const srv = this.srv;
    const key = req.headers["Idempotency-Key"] ?? null;
    const entries: Entry[] = [];
    outs.forEach((out, ordinal) => {
      if ((out["kept_revision"] === null || out["kept_revision"] === undefined) && REVISION_RULES.has(out["rule"] as string))
        out["kept_revision"] = opts.revision;
      srv.resN++;
      const rid = `r${srv.resN}`;
      out["id"] = rid;
      srv.generated++;
      const rule = out["rule"] as string;
      const hasLoser = LOSER_RULES.has(rule) || rule === UNDO;
      const entry: Entry = {
        id: rid,
        entity_type: entity.kind,
        entity_id: entity.id,
        rule,
        field: out["field"] ?? null,
        kept_revision: out["kept_revision"] ?? null,
        has_loser: hasLoser,
        loser: hasLoser ? (out["loser"] ?? null) : null,
        detail: out["detail"] ?? null,
        device_id: null,
        undoes_id: opts.undoes ?? null,
        undone_at: null,
        undone_by: null,
        created_at: `t${srv.resN}`,
        _op_key: key,
        _ordinal: ordinal,
        _op: (req.headers["X-Sim-Op"] ?? req.headers["Idempotency-Key"] ?? "?"),
      };
      if (srv.bugs.resKeepsText && rule === "note_merged") entry["detail"] = entity.fields["content"];
      srv.resTruth.set(rid, { op: entry["_op"], entity_id: entity.id, rule, kept_revision: entry["kept_revision"] });
      entries.push(entry);
      if (srv.bugs.resNotLogged && srv.generated % 3 === 0) return;
      srv.resLog.push(entry);
      srv.resById.set(rid, entry);
      if (!srv.bugs.resNotAnnounced) srv.announce("resolution", rid, "upsert", 1);
    });
    return entries;
  }

  /** Planted defect: a replayed write logs its resolutions again. */
  replayHook(req: Req, body: unknown): void {
    if (!body || typeof body !== "object") return;
    const sync = ((body as Entry)["sync"] ?? {}) as { resolution?: Entry[] };
    const outs = (sync.resolution ?? []).filter((o) => o["rule"] !== UNDO).map((o) => ({ ...o }));
    const entity = this.srv.entities.get(String((body as Entry)["id"] ?? ""));
    if (outs.length && entity) this.log(req, entity, outs, { revision: entity.revision });
  }

  handle(req: Req, rest: string[]): Resp {
    const srv = this.srv;
    if (rest.length === 0 && req.method === "GET") return this.list(req);
    if (rest.length === 1 && req.method === "GET") {
      const entry = srv.resById.get(rest[0]!);
      return entry ? { status: 200, body: wire(entry) } : error(404, "not_found");
    }
    if (rest.length === 2 && rest[1] === "undo" && req.method === "POST") return this.undoEntry(req, rest[0]!);
    return { status: 404, body: { detail: "Not Found" } };
  }

  private list(req: Req): Resp {
    const limit = Number(req.params["limit"] ?? 50);
    if (limit < 1 || limit > 200) return { status: 422, body: { detail: "limit" } };
    let rows = [...this.srv.resLog].reverse();
    if (req.params["entity_id"]) rows = rows.filter((e) => e["entity_id"] === req.params["entity_id"]);
    if (req.params["rule"]) rows = rows.filter((e) => e["rule"] === req.params["rule"]);
    const start = req.params["cursor"] ? Number(req.params["cursor"]) : 0;
    const page = rows.slice(start, start + limit);
    const more = start + limit < rows.length;
    return { status: 200, body: { resolutions: page.map(wire), next_cursor: more ? String(start + limit) : null } };
  }

  private undoEntry(req: Req, rid: string): Resp {
    const srv = this.srv;
    const key = req.headers["Idempotency-Key"];
    if (!key) return error(422, "idempotency_key_required");
    const fingerprint = stable({ resolution_id: rid });
    const stored = srv.idem.get(key);
    if (stored && !srv.bugs.undoNotIdempotent) {
      if (stored[0] !== "resolution.undo" || stored[1] !== fingerprint) return error(409, "idempotency_mismatch");
      return { status: stored[2], body: clone(stored[3]) };
    }
    const resp = this.undo(req, rid);
    if (resp.status >= 200 && resp.status < 300) srv.idem.set(key, ["resolution.undo", fingerprint, resp.status, clone(resp.body)]);
    return resp;
  }

  private undo(req: Req, rid: string): Resp {
    const srv = this.srv;
    const res = srv.resById.get(rid);
    if (!res) return error(404, "not_found");
    if (res["undone_at"] !== null && !srv.bugs.undoTwice) return error(409, "already_undone", { resolution: wire(res) });
    const verdict = undoStatus({
      rule: res["rule"] as string,
      entityId: res["entity_id"] as string,
      keptRevision: res["kept_revision"] as number | null,
      field: res["field"] as string | null,
      hasLoser: res["has_loser"] as boolean,
      undone: false,
    });
    if (!verdict.undoable)
      return error(409, "not_undoable", { reason: verdict.reason, follow_up: verdict.followUp, resolution: wire(res) });
    const entity = srv.entities.get(res["entity_id"] as string);
    if (!entity) return error(409, "entity_deleted");
    let revived = false;
    if (entity.deleted) {
      if (!srv.bugs.undoRevivesDeleted) return error(409, "entity_deleted");
      revived = true;
    }
    const outcome = res["rule"] === SIMPLE_LATER_WINS ? this.undoField(req, res, entity, revived) : this.undoPath(req, res, entity);
    if ("status" in outcome) return outcome;
    const { applied, revision, replaced } = outcome;
    const out: Entry = { rule: UNDO, field: res["field"], kept_revision: revision, loser: replaced };
    let entries: Entry[] = [];
    if (!srv.bugs.undoNotLogged) entries = this.log(req, entity, [out], { revision, undoes: res["id"] as string });
    if (entries.length) {
      res["undone_at"] = UNDONE;
      res["undone_by"] = entries[0]!["id"];
      srv.announce("resolution", res["id"] as string, "upsert", 2);
    }
    const undoWire = entries.length ? wire(entries[0]!) : { ...out, id: null };
    return { status: 200, body: { applied, revision, resolution: wire(res), undo: undoWire } };
  }

  private undoField(
    req: Req,
    res: Entry,
    entity: Entity,
    revived: boolean,
  ): Resp | { applied: boolean; revision: number; replaced: unknown } {
    const srv = this.srv;
    const name = res["field"] as string;
    const loser = res["loser"];
    const changedAt = entity.fieldRevs[name] ?? entity.revision;
    const current = entity.fields[name];
    if (stable(current) === stable(loser)) return { applied: false, revision: entity.revision, replaced: current };
    if (changedAt > (res["kept_revision"] as number) && !srv.bugs.undoIgnoresNewerChange)
      return error(409, "conflict", {
        resolution_id: res["id"],
        conflicts: [{ field: name, reason: "changed_since", server_revision: changedAt, server_value: current }],
      });
    const before = entity.revision;
    entity.revision++;
    entity.deleted = false;
    entity.fields[name] = loser;
    entity.fieldRevs[name] = entity.revision;
    srv.record(entity, "upsert");
    srv.addHistory(req, revived ? "resurrect" : "undo", entity, {
      base: res["kept_revision"] as number,
      revisionBefore: before,
      writes: [[name, changedAt, false]],
    });
    srv.undoTruth.push({
      resolution: res["id"],
      before: current,
      field_revision_before: changedAt,
      kept_revision: res["kept_revision"],
    });
    return { applied: true, revision: entity.revision, replaced: current };
  }

  private undoPath(req: Req, res: Entry, entity: Entity): Resp | { applied: boolean; revision: number; replaced: unknown } {
    const srv = this.srv;
    const currentPath = entity.fields["path"];
    const winner = entity.history.get(res["kept_revision"] as number);
    if ((!winner || winner[1] !== currentPath) && !srv.bugs.undoIgnoresNewerChange)
      return error(409, "conflict", {
        resolution_id: res["id"],
        conflicts: [{ field: "path", reason: "changed_since", server_revision: entity.revision, server_value: currentPath }],
      });
    const target = res["loser"] as string;
    if (target === currentPath) return { applied: false, revision: entity.revision, replaced: currentPath };
    if (srv.notes.taken(target, entity.id)) return error(409, "path_exists");
    const before = entity.revision;
    srv.notes.bump(entity, String(entity.fields["content"]), target, "move");
    srv.addHistory(req, "undo", entity, { base: before, revisionBefore: before });
    srv.undoTruth.push({
      resolution: res["id"],
      before: currentPath,
      field_revision_before: entity.revision - 1,
      kept_revision: res["kept_revision"],
      winner_path: winner ? winner[1] : null,
    });
    return { applied: true, revision: entity.revision, replaced: currentPath };
  }
}
