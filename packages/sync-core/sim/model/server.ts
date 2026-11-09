/**
 * In-memory model of the Atlas server's sync-mode semantics (SYNC-08), a TypeScript port of
 * `services/api/tests/sim/model*.py`: client ids, `Atlas-Sync` negotiation, idempotency, per-field
 * merge, edit-wins, the cursor feed with `include=data`/`types`/snapshot, retention floor, notes
 * (history, three-way merge, conflict copies), the resolution log with undo, an epoch and device
 * revocation. It also records a ground-truth `history` the invariants read.
 *
 * `ServerBugs` plants one defect per flag; each exists so a test can show the matching invariant
 * really fails.
 */

import {
  allFields,
  clone,
  error,
  FLAG,
  FLAG_DEFAULT,
  LABEL,
  sha,
  stable,
  textFields,
  type Req,
  type Resp,
  type SimKind,
} from "./common.ts";
import { ModelNotes } from "./notes.ts";
import { ModelResolutions, wire } from "./resolutions.ts";

/** The clamp of `acted_at` (R-68, ADR-0068 D11); the real server's `ACTED_AT_MAX_AGE`/`ACTED_AT_MAX_FUTURE`. */
export const ACTED_AT_MAX_AGE_MS = 24 * 3_600_000;
export const ACTED_AT_MAX_FUTURE_MS = 5 * 60_000;
export const SNOOZE_SECONDS = [600, 3600, 10800] as const;
/** Statuses for which a reminder may still fire (the real server's `DELIVERABLE_STATUSES`). */
export const DELIVERABLE = ["inbox", "next", "in_progress"] as const;
/** The real task state machine (`atlas/tasks/state.py`): a completed task may only be reopened to in_progress. */
const TRANSITIONS: Record<string, readonly string[]> = {
  inbox: ["next", "in_progress", "completed", "archived"],
  next: ["inbox", "in_progress", "completed", "archived"],
  in_progress: ["inbox", "next", "completed", "archived"],
  completed: ["in_progress", "archived"],
  archived: ["inbox", "next"],
};

export const PROTOCOL_MIN = 1;
export const PROTOCOL_MAX = 1;
const KIND_OF: Record<string, SimKind> = { tasks: "task", projects: "project" };

export interface ServerBugs {
  ignoreIdempotency?: boolean;
  /** every 4th sync patch is acknowledged (200 + body) but not applied */
  ackButDropWrite?: boolean;
  lwwByClientTime?: boolean;
  skipFeedRow?: boolean;
  feedCursorSkips?: boolean;
  mergeIgnoresFieldRevisions?: boolean;
  staleDeleteWins?: boolean;
  noRevive?: boolean;
  snapshotSkipsEntity?: boolean;
  acceptsAnyProtocol?: boolean;
  notesOverwriteOnStale?: boolean;
  notesMergeDropsOurs?: boolean;
  notesDropAcknowledgedWrite?: boolean;
  notesIgnorePathCollisions?: boolean;
  notesConflictCopyTruncated?: boolean;
  notesConflictNotStored?: boolean;
  resNotLogged?: boolean;
  resLoggedOnReplay?: boolean;
  resLoggedWithoutWrite?: boolean;
  resNotAnnounced?: boolean;
  resKeepsText?: boolean;
  undoIgnoresNewerChange?: boolean;
  undoTwice?: boolean;
  undoNotLogged?: boolean;
  undoNotIdempotent?: boolean;
  undoRevivesDeleted?: boolean;
  /** a 2xx reply to a retried create returns a brand new entity id (a second entity) */
  restoreKeepsNewerLog?: boolean;
  // --- reminders (M8-04b-ii)
  /** a reminder change is applied but never announced on the feed */
  reminderNotAnnounced?: boolean;
  /** `acted_at` is ignored: the snooze counts from the server clock (R-68 undone) */
  actedAtIgnored?: boolean;
  /** `acted_at` is not clamped to the safe window */
  actedAtUnclamped?: boolean;
  /** a replayed action is applied again (not idempotent) */
  actionNotIdempotent?: boolean;
  /** a dismissal is acknowledged but never recorded */
  dismissNotRecorded?: boolean;
  /** a since=0 walk restricted to `reminder` omits one reminder */
  reminderSnapshotSkips?: boolean;
  /** a task completion does not cancel its reminder */
  completionKeepsReminder?: boolean;
}

export interface ModelOptions {
  /** Tasks carry `due_at`/`status` and the server derives the `reminder` entity from them. */
  reminders?: boolean;
  /** Server time in epoch ms (the world's virtual wall clock); the model has none of its own. */
  clock?: () => number;
}

export interface ModelReminder {
  id: string;
  taskId: string;
  revision: number;
  state: "armed" | "cancelled";
  remindAt: number;
  snoozedUntil: number | null;
  acknowledgedAt: number | null;
}

/** What the server did with one action: the ground truth the reminder invariants read. */
export interface ActionTruth {
  actionId: string;
  reminderId: string;
  kind: "snooze" | "dismiss";
  seconds: number | null;
  /** `acted_at` as received (epoch ms), `null` when the request had none */
  actedAtSent: number | null;
  serverNow: number;
  /** the instant the action was counted from, after clamping */
  base: number;
  applied: boolean;
  /** the reminder was armed when the action arrived (an action on a cancelled reminder changes nothing, 14.5) */
  armed: boolean;
  /** snooze: the resulting `snoozed_until` (epoch ms) */
  until: number | null;
  /** how many times the action changed the reminder (must be 1 or 0) */
  applications: number;
}

export interface Entity {
  kind: SimKind | "note";
  id: string;
  fields: Record<string, unknown>;
  revision: number;
  deleted: boolean;
  lastClientTime: number;
  fieldRevs: Record<string, number>;
  /** notes: revision -> [content, path, reason] */
  history: Map<number, [string, string, string]>;
}

export interface HistoryEvent {
  opId: string;
  event: string;
  kind: string;
  entityId: string;
  revision: number;
  base: number | null;
  revisionBefore: number | null;
  writes: [string, number, boolean][];
  extra: Record<string, unknown>;
}

export interface FeedRow {
  seq: number;
  kind: string;
  entityId: string;
  operation: "upsert" | "delete";
  revision: number;
}

export class ModelServer {
  bugs: ServerBugs;
  entities = new Map<string, Entity>();
  feed = new Map<string, FeedRow>();
  headSeq = 0;
  floor = 0;
  idem = new Map<string, [string, string, number, unknown]>();
  history: HistoryEvent[] = [];
  nextId = 0;
  mutations = 0;
  patches = 0;
  epoch = "epoch-1";
  /** Devices (clients) the owner has revoked: every request of theirs is `401 token_revoked`. */
  revoked = new Set<string>();
  /** Requests of a revoked client that were answered 2xx (must stay empty). */
  servedAfterRevoke: string[] = [];
  notes: ModelNotes;
  res: ModelResolutions;
  // the resolution log lives here so a snapshot/restore carries it like a table
  resLog: Record<string, unknown>[] = [];
  resById = new Map<string, Record<string, unknown>>();
  resTruth = new Map<string, Record<string, unknown>>();
  undoTruth: Record<string, unknown>[] = [];
  generated = 0;
  resN = 0;
  readonly options: ModelOptions;
  reminders = new Map<string, ModelReminder>();
  reminderOfTask = new Map<string, string>();
  actions = new Map<string, ActionTruth>();
  reminderRevisions = new Map<string, number>();

  constructor(bugs: ServerBugs = {}, options: ModelOptions = {}) {
    this.bugs = bugs;
    this.options = options;
    this.notes = new ModelNotes(this);
    this.res = new ModelResolutions(this);
  }

  async revokeDevice(cid: string): Promise<void> {
    this.revoked.add(cid);
  }

  async head(): Promise<number> {
    return this.headSeq;
  }

  async allEntityIds(): Promise<string[]> {
    return [...this.entities.keys()];
  }

  async handle(req: Req): Promise<Resp> {
    const client = req.headers["X-Sim-Client"];
    if (client && this.revoked.has(client)) return error(401, "token_revoked");
    const resp = await this.dispatch(req);
    return resp;
  }

  private async dispatch(req: Req): Promise<Resp> {
    const sync = this.protocol(req);
    if (typeof sync !== "boolean") return sync;
    const parts = req.path.split("/").filter(Boolean);
    if (parts[0] === "api" && parts[1] === "instance" && req.method === "GET") {
      return {
        status: 200,
        body: {
          sync: {
            protocol: { min: PROTOCOL_MIN, max: PROTOCOL_MAX },
            entities: { task: 1, project: 1, note: 1, resolution: 1, ...(this.options.reminders ? { reminder: 1 } : {}) },
            epoch: this.epoch,
          },
        },
      };
    }
    const gated = this.epochCheck(req, parts);
    if (gated) return gated;
    if (parts[0] === "api" && parts[1] === "changes" && req.method === "GET") return this.changes(req);
    if (parts[0] === "api" && parts[1] === "sync" && parts[2] === "resolutions")
      return this.res.handle(req, parts.slice(3));
    if (parts[0] === "api" && parts[1] === "notes") return this.notes.handle(req, sync, parts.slice(2));
    if (parts[0] === "api" && parts[1] === "reminders" && this.options.reminders) return this.reminderApi(req, parts.slice(2));
    if (parts.length < 2 || parts[0] !== "api" || !(parts[1]! in KIND_OF))
      return { status: 404, body: { detail: "Not Found" } };
    const kind = KIND_OF[parts[1]!]!;
    const rest = parts.slice(2);
    if (rest.length === 0) {
      if (req.method === "POST") return sync ? this.syncCreate(req, kind) : this.legacyOnly();
      if (req.method === "GET") {
        const live = [...this.entities.values()].filter((e) => e.kind === kind && !e.deleted);
        return { status: 200, body: { [parts[1]!]: live.map((e) => this.out(e)) } };
      }
    } else if (rest.length === 1) {
      const id = rest[0]!;
      if (req.method === "GET") {
        const entity = this.live(kind, id);
        return entity ? { status: 200, body: this.out(entity) } : { status: 404, body: { detail: "Not found" } };
      }
      if (req.method === "PATCH") return sync ? this.syncPatch(req, kind, id) : this.legacyOnly();
      if (req.method === "DELETE") return sync ? this.syncDelete(req, kind, id) : this.legacyOnly();
    } else if (rest.length === 2 && rest[1] === "restore" && kind === "task" && req.method === "POST") {
      if (sync && !req.headers["Idempotency-Key"]) return error(422, "idempotency_key_required");
      return this.idempotent(req, "task.restore", { id: rest[0] }, () => this.restore(req, kind, rest[0]!));
    }
    return { status: 404, body: { detail: "Not Found" } };
  }

  private legacyOnly(): Resp {
    return { status: 500, body: { detail: "the model only implements writes in sync mode" } };
  }

  private protocol(req: Req): boolean | Resp {
    const raw = req.headers["Atlas-Sync"];
    if (raw === undefined) return false;
    const text = raw.trim();
    const ok = /^[0-9]+$/.test(text) && Number(text) >= PROTOCOL_MIN && Number(text) <= PROTOCOL_MAX;
    if (!ok && !this.bugs.acceptsAnyProtocol)
      return {
        status: 426,
        body: { error: "sync_version_unsupported", min: PROTOCOL_MIN, max: PROTOCOL_MAX },
      };
    return true;
  }

  private epochCheck(req: Req, parts: string[]): Resp | null {
    const sent = req.headers["Atlas-Epoch"];
    if (sent === undefined || sent === this.epoch) return null;
    if (parts[0] === "api" && ["tasks", "projects", "notes", "changes", "sync", "reminders"].includes(parts[1] ?? ""))
      return error(409, "epoch_mismatch", { epoch: this.epoch });
    return null;
  }

  // --- idempotency --------------------------------------------------------------------------

  idempotent(req: Req, operation: string, payload: unknown, fn: () => Resp): Resp {
    const key = req.headers["Idempotency-Key"];
    const fingerprint = stable(payload);
    if (key && !this.bugs.ignoreIdempotency) {
      const stored = this.idem.get(key);
      if (stored) {
        if (stored[0] !== operation || stored[1] !== fingerprint) return error(409, "idempotency_mismatch");
        if (this.bugs.resLoggedOnReplay) this.res.replayHook(req, stored[3]);
        return { status: stored[2], body: clone(stored[3]) };
      }
    }
    const resp = fn();
    if (key && !this.bugs.ignoreIdempotency && resp.status >= 200 && resp.status < 300)
      this.idem.set(key, [operation, fingerprint, resp.status, clone(resp.body)]);
    return resp;
  }

  // --- tasks and projects (sync mode) -------------------------------------------------------

  /** The writable fields of a kind: tasks also carry `due_at` and `status` when reminders are modelled. */
  fieldsOf(kind: SimKind): string[] {
    return kind === "task" && this.options.reminders ? [...allFields(kind), "due_at", "status"] : allFields(kind);
  }

  newEntity(kind: SimKind, id: string, label: string, description: unknown): Entity {
    const entity: Entity = {
      kind,
      id,
      fields: { [LABEL[kind]]: label, description, [FLAG[kind]]: FLAG_DEFAULT[kind] },
      revision: 1,
      deleted: false,
      lastClientTime: -1e18,
      fieldRevs: Object.fromEntries(this.fieldsOf(kind).map((f) => [f, 1])),
      history: new Map(),
    };
    if (kind === "task" && this.options.reminders) {
      entity.fields["due_at"] = null;
      entity.fields["status"] = "inbox";
    }
    return entity;
  }

  private syncCreate(req: Req, kind: SimKind): Resp {
    if (!req.headers["Idempotency-Key"]) return error(422, "idempotency_key_required");
    const body = { ...(req.body ?? {}) };
    const unknown = Object.keys(body).filter((k) => k !== "id" && !this.fieldsOf(kind).includes(k)).sort();
    if (unknown.length) return error(422, "unknown_fields", { fields: unknown });
    return this.idempotent(req, `${kind}.create`, body, () => this.createWithId(req, kind));
  }

  private createWithId(req: Req, kind: SimKind): Resp {
    const body = { ...(req.body ?? {}) } as Record<string, unknown>;
    const label = body[LABEL[kind]];
    if (typeof label !== "string" || !label) return { status: 422, body: { detail: "validation" } };
    const clientId = body["id"] as string | undefined;
    let id: string;
    if (clientId !== undefined) {
      const existing = this.entities.get(clientId);
      if (existing) {
        const same =
          existing.kind === kind &&
          !existing.deleted &&
          existing.revision === 1 &&
          existing.fields[LABEL[kind]] === label &&
          (existing.fields["description"] ?? null) === (body["description"] ?? null) &&
          existing.fields[FLAG[kind]] === (body[FLAG[kind]] ?? FLAG_DEFAULT[kind]);
        if (same) return { status: 201, body: this.out(existing, { sync: true }) };
        return error(409, "id_exists");
      }
      id = clientId;
    } else {
      this.nextId++;
      id = `e${this.nextId}`;
    }
    const entity = this.newEntity(kind, id, label, body["description"] ?? null);
    entity.fields[FLAG[kind]] = body[FLAG[kind]] ?? FLAG_DEFAULT[kind];
    if (kind === "task" && this.options.reminders) {
      if (body["due_at"] !== undefined) entity.fields["due_at"] = body["due_at"];
      if (body["status"] !== undefined) entity.fields["status"] = body["status"];
    }
    this.entities.set(entity.id, entity);
    this.record(entity, "upsert");
    this.syncReminder(entity);
    this.addHistory(req, "create", entity);
    return { status: 201, body: this.out(entity, { sync: true }) };
  }

  private syncPatch(req: Req, kind: SimKind, id: string): Resp {
    if (!req.headers["Idempotency-Key"]) return error(422, "idempotency_key_required");
    const body = { ...(req.body ?? {}) } as Record<string, unknown>;
    if (body["base_revision"] === null || body["base_revision"] === undefined)
      return error(422, "base_revision_required");
    const unknown = Object.keys(body).filter((k) => k !== "base_revision" && !this.fieldsOf(kind).includes(k)).sort();
    if (unknown.length) return error(422, "unknown_fields", { fields: unknown });
    const held = this.entities.get(id);
    const requested = body["status"];
    if (this.options.reminders && kind === "task" && held && typeof requested === "string") {
      const current = String(held.fields["status"]);
      if (requested !== current && !(TRANSITIONS[current] ?? []).includes(requested))
        return { status: 422, body: { detail: `cannot move a task from ${current} to ${requested}`, error: "invalid_transition" } };
    }
    return this.idempotent(req, `${kind}.update`, { id, ...body }, () => this.mergePatch(req, kind, id));
  }

  private mergePatch(req: Req, kind: SimKind, id: string): Resp {
    const entity = this.entities.get(id);
    if (!entity || entity.kind !== kind) return error(404, "not_found");
    if (entity.deleted && this.bugs.noRevive) return error(404, "not_found");
    const body = { ...(req.body ?? {}) } as Record<string, unknown>;
    const base = Number(body["base_revision"]);
    delete body["base_revision"];
    if (base > entity.revision) return error(409, "stale", { current_revision: entity.revision });
    const revived = entity.deleted;
    const applied: Record<string, unknown> = {};
    const conflicts: Record<string, unknown>[] = [];
    const resolutions: Record<string, unknown>[] = [];
    const writes: [string, number, boolean][] = [];
    for (const [name, value] of Object.entries(body)) {
      const changedAt = entity.fieldRevs[name] ?? entity.revision;
      const equal = stable(entity.fields[name]) === stable(value);
      if (this.bugs.mergeIgnoresFieldRevisions || changedAt <= base) {
        if (!equal) {
          applied[name] = value;
          writes.push([name, changedAt, false]);
        }
      } else if (equal) {
        continue;
      } else if (textFields(kind).includes(name)) {
        conflicts.push({
          field: name,
          reason: "text_conflict",
          server_revision: changedAt,
          server_value: entity.fields[name],
        });
      } else {
        applied[name] = value;
        writes.push([name, changedAt, false]);
        resolutions.push({
          rule: "simple_later_wins",
          field: name,
          kept_revision: entity.revision + 1,
          loser: entity.fields[name],
          detail: null,
        });
      }
    }
    const appliedAny = Object.keys(applied).length > 0;
    if (conflicts.length && !appliedAny && !revived)
      return error(409, "conflict", { current_revision: entity.revision, conflicts });
    if (!appliedAny && !revived)
      return { status: 200, body: this.out(entity, { sync: true, conflicts }) };
    this.patches++;
    const clientTime = Number(req.headers["X-Client-Time"] ?? "0");
    if (this.bugs.lwwByClientTime && clientTime < entity.lastClientTime)
      return { status: 200, body: this.out(entity, { sync: true }) };
    if (this.bugs.ackButDropWrite && this.patches % 4 === 0)
      return { status: 200, body: this.out(entity, { sync: true }) };
    const before = entity.revision;
    entity.revision++;
    entity.deleted = false;
    for (const [name, value] of Object.entries(applied)) {
      entity.fields[name] = value;
      entity.fieldRevs[name] = entity.revision;
    }
    entity.lastClientTime = Math.max(entity.lastClientTime, clientTime);
    this.record(entity, "upsert");
    this.syncReminder(entity);
    this.addHistory(req, revived ? "revive" : "patch", entity, { base, revisionBefore: before, writes });
    if (revived)
      resolutions.push({
        rule: "edit_wins_over_delete",
        field: null,
        kept_revision: null,
        loser: null,
        detail: null,
      });
    this.res.log(req, entity, resolutions, { revision: entity.revision });
    return { status: 200, body: this.out(entity, { sync: true, conflicts, resolutions }) };
  }

  private syncDelete(req: Req, kind: SimKind, id: string): Resp {
    if (!req.headers["Idempotency-Key"]) return error(422, "idempotency_key_required");
    if (req.params["base_revision"] === undefined) return error(422, "base_revision_required");
    return this.idempotent(req, `${kind}.delete`, { id }, () => this.guardedDelete(req, kind, id));
  }

  private guardedDelete(req: Req, kind: SimKind, id: string): Resp {
    const entity = this.entities.get(id);
    if (!entity || entity.kind !== kind) return error(404, "not_found");
    if (entity.deleted) return { status: 204, body: null };
    const base = Number(req.params["base_revision"]);
    if (base < entity.revision && !this.bugs.staleDeleteWins) {
      if (this.bugs.resLoggedWithoutWrite)
        this.res.log(req, entity, [{ rule: "edit_wins_over_delete", field: null, kept_revision: null }], {
          revision: entity.revision,
        });
      return error(409, "edit_wins", {
        current_revision: entity.revision,
        entity: this.out(entity),
        resolution: [{ rule: "edit_wins_over_delete" }],
      });
    }
    const before = entity.revision;
    entity.deleted = true;
    entity.revision++;
    this.record(entity, "delete");
    this.syncReminder(entity);
    this.addHistory(req, "delete", entity, { base, revisionBefore: before });
    return { status: 204, body: null };
  }

  private restore(req: Req, kind: SimKind, id: string): Resp {
    const entity = this.entities.get(id);
    if (!entity || entity.kind !== kind || !entity.deleted) return { status: 404, body: { detail: "Not found" } };
    entity.deleted = false;
    entity.revision++;
    this.record(entity, "upsert");
    this.syncReminder(entity);
    this.addHistory(req, "restore", entity);
    return { status: 200, body: this.out(entity) };
  }

  // --- reminders (M8-04a/b-ii): a server-derived entity, SYNC_PROTOCOL 14.2 and 14.5 ----------------

  private iso(ms: number | null): string | null {
    return ms === null ? null : new Date(ms).toISOString();
  }

  reminderOut(r: ModelReminder): Record<string, unknown> {
    return {
      id: r.id,
      revision: r.revision,
      task_id: r.taskId,
      state: r.state,
      remind_at: this.iso(r.remindAt),
      snoozed_until: this.iso(r.snoozedUntil),
      acknowledged_at: this.iso(r.acknowledgedAt),
      effective_at: this.iso(r.snoozedUntil ?? r.remindAt),
      server_delivered_at: null,
    };
  }

  private publishReminder(
    r: ModelReminder,
    change: { state?: "armed" | "cancelled"; remindAt?: number; snoozedUntil?: number | null; acknowledgedAt?: number | null },
  ): boolean {
    let changed = false;
    if (change.remindAt !== undefined && r.remindAt !== change.remindAt) {
      r.remindAt = change.remindAt;
      changed = true;
      if (change.snoozedUntil === undefined) change.snoozedUntil = null; // a moved schedule supersedes the snooze
    }
    if (change.state !== undefined && r.state !== change.state) {
      r.state = change.state;
      changed = true;
    }
    if (change.snoozedUntil !== undefined && r.snoozedUntil !== change.snoozedUntil) {
      r.snoozedUntil = change.snoozedUntil;
      changed = true;
    }
    if (change.acknowledgedAt !== undefined && r.acknowledgedAt !== change.acknowledgedAt) {
      r.acknowledgedAt = change.acknowledgedAt;
      changed = true;
    }
    if (changed) {
      r.revision++;
      if (!this.bugs.reminderNotAnnounced) this.announce("reminder", r.id, "upsert", r.revision);
    }
    return changed;
  }

  /** `sync_task`: materialise, move or cancel the task's reminder in the writer's transaction. */
  private syncReminder(task: Entity): void {
    if (!this.options.reminders || task.kind !== "task") return;
    const due = task.fields["due_at"];
    const status = task.fields["status"];
    const deliverable =
      !task.deleted && typeof due === "string" && (DELIVERABLE as readonly unknown[]).includes(status);
    const held = this.reminderOfTask.get(task.id);
    const existing = held ? this.reminders.get(held) : undefined;
    if (!deliverable) {
      // planted: a completion (not a deletion) leaves the reminder armed
      if (existing && !(this.bugs.completionKeepsReminder && !task.deleted)) this.publishReminder(existing, { state: "cancelled" });
      return;
    }
    const remindAt = Date.parse(due as string);
    if (!existing) {
      const id = `r-${task.id}`;
      const created: ModelReminder = {
        id, taskId: task.id, revision: 1, state: "armed", remindAt, snoozedUntil: null, acknowledgedAt: null,
      };
      this.reminders.set(id, created);
      this.reminderOfTask.set(task.id, id);
      if (!this.bugs.reminderNotAnnounced) this.announce("reminder", id, "upsert", 1);
      return;
    }
    this.publishReminder(existing, { state: "armed", remindAt });
  }

  private clampActedAt(actedAt: number | null, now: number): number {
    if (actedAt === null || this.bugs.actedAtIgnored) return now;
    if (this.bugs.actedAtUnclamped) return actedAt;
    return Math.min(Math.max(actedAt, now - ACTED_AT_MAX_AGE_MS), now + ACTED_AT_MAX_FUTURE_MS);
  }

  private reminderApi(req: Req, rest: string[]): Resp {
    if (rest.length === 0 && req.method === "GET") {
      const state = req.params["state"];
      const list = [...this.reminders.values()]
        .filter((r) => !state || r.state === state)
        .sort((a, b) => a.remindAt - b.remindAt || (a.id < b.id ? -1 : 1));
      return { status: 200, body: { reminders: list.map((r) => this.reminderOut(r)) } };
    }
    if (rest.length === 2 && rest[1] === "actions" && req.method === "POST") {
      const key = req.headers["Idempotency-Key"];
      const body = { ...(req.body ?? {}) } as Record<string, unknown>;
      if (key !== undefined && key !== body["action_id"]) return error(422, "idempotency_key_mismatch");
      const payload = { reminder_id: rest[0], ...body };
      const bad = this.invalidAction(body);
      if (bad) return { status: 422, body: { detail: bad } };
      if (this.bugs.actionNotIdempotent) return this.act(rest[0]!, body);
      return this.idempotent(req, "reminder.action", payload, () => this.act(rest[0]!, body));
    }
    return { status: 404, body: { detail: "Not Found" } };
  }

  private invalidAction(body: Record<string, unknown>): string | null {
    if (typeof body["action_id"] !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body["action_id"]))
      return "action_id must be a UUID";
    const kind = body["kind"];
    if (kind !== "snooze" && kind !== "dismiss") return "kind";
    const seconds = body["snooze_for_seconds"];
    const until = body["until"];
    if (seconds !== undefined && seconds !== null && !(SNOOZE_SECONDS as readonly unknown[]).includes(seconds)) return "snooze_for_seconds";
    if (until !== undefined && until !== null) return "until is not modelled";
    const given = seconds === undefined || seconds === null ? 0 : 1;
    if (kind === "snooze" && given !== 1) return "snooze needs exactly one target";
    if (kind === "dismiss" && given) return "dismiss takes no duration";
    const acted = body["acted_at"];
    if (acted !== undefined && acted !== null && !(typeof acted === "string" && /(Z|[+-]\d\d:\d\d)$/.test(acted) && Number.isFinite(Date.parse(acted))))
      return "acted_at needs an offset";
    return null;
  }

  private act(id: string, body: Record<string, unknown>): Resp {
    const r = this.reminders.get(id);
    if (!r) return error(404, "not_found");
    const baseRevision = typeof body["base_revision"] === "number" ? (body["base_revision"] as number) : null;
    if (baseRevision !== null && baseRevision > r.revision) return error(409, "revision_ahead", { current_revision: r.revision });
    const stale = baseRevision !== null && baseRevision < r.revision;
    const now = (this.options.clock ?? (() => 0))();
    const actedAt = typeof body["acted_at"] === "string" ? Date.parse(body["acted_at"] as string) : null;
    const base = this.clampActedAt(actedAt, now);
    const kind = body["kind"] as "snooze" | "dismiss";
    const seconds = typeof body["snooze_for_seconds"] === "number" ? (body["snooze_for_seconds"] as number) : null;
    let applied = false;
    let until: number | null = null;
    if (r.state === "armed") {
      if (kind === "snooze") {
        until = base + seconds! * 1000;
        applied = this.publishReminder(r, { snoozedUntil: until, acknowledgedAt: null });
      } else if (!this.bugs.dismissNotRecorded) {
        const due = r.snoozedUntil ?? r.remindAt;
        if (r.acknowledgedAt === null || r.acknowledgedAt < due)
          applied = this.publishReminder(r, { snoozedUntil: null, acknowledgedAt: Math.max(base, due, r.remindAt) });
      }
    }
    const actionId = body["action_id"] as string;
    const held = this.actions.get(actionId);
    this.actions.set(actionId, {
      actionId, reminderId: id, kind, seconds, actedAtSent: actedAt, serverNow: now, base, applied, armed: r.state === "armed" || applied, until,
      applications: (held?.applications ?? 0) + (applied ? 1 : 0),
    });
    return { status: 200, body: { reminder: this.reminderOut(r), applied, stale } };
  }

  // --- feed ---------------------------------------------------------------------------------

  record(entity: Entity, operation: "upsert" | "delete"): void {
    this.mutations++;
    if (this.bugs.skipFeedRow && this.mutations % 4 === 0) return;
    this.announce(entity.kind, entity.id, operation, entity.revision);
  }

  announce(kind: string, entityId: string, operation: "upsert" | "delete", revision: number): void {
    this.headSeq++;
    this.feed.set(`${kind}:${entityId}`, { seq: this.headSeq, kind, entityId, operation, revision });
  }

  addHistory(
    req: Req,
    event: string,
    entity: Entity,
    extra: { base?: number | null; revisionBefore?: number | null; writes?: [string, number, boolean][] } = {},
  ): void {
    this.history.push({
      opId: (req.headers["X-Sim-Op"] ?? req.headers["Idempotency-Key"] ?? "?"),
      event,
      kind: entity.kind,
      entityId: entity.id,
      revision: entity.revision,
      base: extra.base ?? null,
      revisionBefore: extra.revisionBefore ?? null,
      writes: extra.writes ?? [],
      extra: {},
    });
  }

  private changes(req: Req): Resp {
    const rawSince = req.params["since"];
    const rawLimit = req.params["limit"];
    const since = rawSince === undefined ? 0 : Number(rawSince);
    const limit = rawLimit === undefined ? 200 : Number(rawLimit);
    const include = req.params["include"];
    const cap = include === "data" ? 200 : 500;
    if (!(since >= 0) || since > 2 ** 53 || !(limit >= 1) || limit > cap)
      return { status: 422, body: { detail: "out of range" } };
    const wanted = req.params["types"];
    const types = wanted ? new Set(String(wanted).split(",")) : null;
    const base = {
      changes: [] as unknown[],
      since,
      has_more: false,
      resync_required: false,
      resync_reason: null as string | null,
      head: this.headSeq,
      floor: this.floor,
    };
    if (since > this.headSeq)
      return {
        status: 200,
        body: { ...base, next_since: this.headSeq, resync_required: true, resync_reason: "cursor_ahead" },
      };
    if (since > 0 && since < this.floor && !req.params["snapshot"])
      return {
        status: 200,
        body: {
          ...base,
          next_since: Math.max(this.headSeq, this.floor),
          resync_required: true,
          resync_reason: "below_floor",
        },
      };
    let rows = [...this.feed.values()].filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq);
    if (since === 0) {
      rows = rows.filter((r) => r.operation === "upsert");
      if (this.bugs.snapshotSkipsEntity && rows.length) rows = rows.slice(1);
    }
    if (types) rows = rows.filter((r) => types.has(r.kind));
    else if (req.headers["Atlas-Sync"] === undefined) rows = rows.filter((r) => r.kind !== "resolution" && r.kind !== "reminder");
    if (since === 0 && this.bugs.reminderSnapshotSkips && types && [...types].every((t) => t === "reminder")) {
      const first = rows.find((r) => r.kind === "reminder");
      if (first) rows = rows.filter((r) => r !== first);
    }
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    let nextSince = page.length ? page[page.length - 1]!.seq : since;
    if (hasMore && this.bugs.feedCursorSkips) nextSince += 1;
    if (!hasMore) nextSince = Math.max(nextSince, this.headSeq);
    const items = page.map((r) => {
      const item: Record<string, unknown> = {
        entity_type: r.kind,
        entity_id: r.entityId,
        operation: r.operation,
        cursor: r.seq,
      };
      if (include === "data" && r.kind === "reminder") {
        const reminder = this.reminders.get(r.entityId)!;
        item["revision"] = reminder.revision;
        item["data"] = this.reminderOut(reminder);
      } else if (include === "data" && r.kind === "resolution") {
        item["revision"] = r.revision;
        item["data"] = wire(this.resById.get(r.entityId)!);
      } else if (include === "data" && r.kind === "note") {
        const entity = this.entities.get(r.entityId)!;
        item["revision"] = entity.revision;
        item["data"] = this.notes.feedData(entity);
      } else if (include === "data") {
        const entity = this.entities.get(r.entityId)!;
        item["revision"] = entity.revision;
        item["data"] = {
          id: entity.id,
          revision: entity.revision,
          field_revisions: { ...entity.fieldRevs },
          deleted_at: entity.deleted ? "deleted" : null,
          ...entity.fields,
        };
      }
      return item;
    });
    return { status: 200, body: { ...base, changes: items, next_since: nextSince, has_more: hasMore } };
  }

  /** Retention purge: tombstones at or below `upto` go and the floor rises; upserts stay. */
  purge(upto: number): void {
    const limit = Math.min(upto, this.headSeq);
    const gone = [...this.feed.entries()].filter(([, r]) => r.operation === "delete" && r.seq <= limit);
    if (!gone.length) return;
    this.floor = Math.max(this.floor, ...gone.map(([, r]) => r.seq));
    for (const [key] of gone) this.feed.delete(key);
  }

  /** A backup restore: replace this server's state by an older snapshot (the operator rotates the epoch). */
  restoreFrom(snapshot: ModelServer): void {
    const names: (keyof ModelServer)[] = ["entities", "feed", "headSeq", "floor", "idem", "history", "reminders", "reminderOfTask", "actions"];
    if (!this.bugs.restoreKeepsNewerLog)
      names.push("resLog", "resById", "resTruth", "undoTruth", "generated", "resN");
    for (const name of names) (this as unknown as Record<string, unknown>)[name] = (snapshot as unknown as Record<string, unknown>)[name];
  }

  snapshot(): ModelServer {
    const copy = new ModelServer(this.bugs, this.options);
    copy.reminders = clone(this.reminders);
    copy.reminderOfTask = clone(this.reminderOfTask);
    copy.actions = clone(this.actions);
    copy.entities = clone(this.entities);
    copy.feed = clone(this.feed);
    copy.idem = clone(this.idem);
    copy.history = clone(this.history);
    copy.resLog = clone(this.resLog);
    copy.resTruth = clone(this.resTruth);
    copy.undoTruth = clone(this.undoTruth);
    copy.resById = new Map(copy.resLog.map((e) => [e["id"] as string, e]));
    copy.generated = this.generated;
    copy.resN = this.resN;
    copy.headSeq = this.headSeq;
    copy.floor = this.floor;
    copy.notes.copies = this.notes.copies;
    copy.nextId = this.nextId;
    copy.mutations = this.mutations;
    copy.patches = this.patches;
    copy.epoch = this.epoch;
    return copy;
  }

  rotateEpoch(): string {
    this.epoch = `epoch-${Number(this.epoch.split("-")[1]) + 1}`;
    return this.epoch;
  }

  // --- helpers ------------------------------------------------------------------------------

  live(kind: SimKind, id: string): Entity | undefined {
    const entity = this.entities.get(id);
    return entity && entity.kind === kind && !entity.deleted ? entity : undefined;
  }

  out(
    entity: Entity,
    opts: { sync?: boolean; conflicts?: Record<string, unknown>[]; resolutions?: Record<string, unknown>[] } = {},
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {
      id: entity.id,
      revision: entity.revision,
      ...entity.fields,
      field_revisions: { ...entity.fieldRevs },
    };
    if (opts.sync)
      out["sync"] = {
        revision: entity.revision,
        resolution: opts.resolutions ?? [],
        conflicts: opts.conflicts ?? [],
      };
    return out;
  }

  /** Final state keyed by entity id, to compare runs (clock independence). */
  canonical(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const e of this.entities.values())
      out[e.id] = [e.kind, stable(e.fields), e.revision, e.deleted];
    return out;
  }

  contentHash(text: string): string {
    return sha(text);
  }
}
