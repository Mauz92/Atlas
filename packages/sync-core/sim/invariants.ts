/**
 * The invariants of `docs/TESTING.md` 10.2, checked against what the REAL sync-core did. A failure
 * is a `SimFailure` carrying the seed (SYNC-08). Mirrors `services/api/tests/sim/runner.py`.
 */

import type { Problem, ResolutionRecord } from "../src/types.ts";
import { checkPortable, foldPath } from "../src/portable.ts";
import { FLAG, LABEL, sha, type Req, type SimKind } from "./model/common.ts";
import type { ModelServer } from "./model/server.ts";
import { markers, type SimClient, type World } from "./world.ts";

type Truth = Map<string, { kind: string; fields: Record<string, unknown>; revision: number }>;

const PLURAL: Record<SimKind, string> = { task: "tasks", project: "projects" };

export async function checkCursorSafety(world: World, client: SimClient): Promise<void> {
  const model = world.model();
  if (!model || world.restored) return;
  const state = client.store.peek();
  const cursor = (state.meta.get("cursor") as number | undefined) ?? 0;
  for (const row of model.feed.values()) {
    if (row.seq > cursor) continue;
    if (row.kind === "resolution") {
      if (!world.cfg.resolutions) continue;
      const held = state.resolutions.get(row.entityId);
      const have = !held ? null : held.undone_at ? 2 : 1;
      if (have === null || have < row.revision)
        throw world.fail(
          "cursor_safety",
          `${client.cid} has cursor ${cursor} but never applied resolution row #${row.seq} (${row.entityId} state ${row.revision}); holds ${JSON.stringify(held)}`,
        );
      continue;
    }
    if (row.kind === "reminder") {
      // only once the type is recorded as synced: before that its rows are filtered out of the main pull
      // on purpose and arrive through the backfill (G7); a type marked synced without it is the defect
      const synced = (state.meta.get("types_synced") as string[] | undefined) ?? [];
      if (!world.cfg.reminders || !synced.includes("reminder")) continue;
      const held = state.entities.get(row.entityId);
      if (!held || held.deleted || !held.server || held.server.revision < row.revision)
        throw world.fail(
          "cursor_safety",
          `${client.cid} has cursor ${cursor} and reminders recorded as synced, but never applied reminder row #${row.seq} (${row.entityId} rev ${row.revision}); mirror has ${JSON.stringify(held)}`,
        );
      continue;
    }
    const local = state.entities.get(row.entityId);
    if (local?.refetch) continue; // an acknowledged write brought it in; the next pull reads it again
    const ok =
      row.operation === "delete"
        ? !local || local.deleted || !local.server
        : !!local && !local.deleted && !!local.server && local.server.revision >= row.revision;
    if (!ok)
      throw world.fail(
        "cursor_safety",
        `${client.cid} has cursor ${cursor} but never applied feed row #${row.seq} (${row.operation} ${row.kind} ${row.entityId} rev ${row.revision}); mirror has ${JSON.stringify(local)}`,
      );
  }
}

export async function serverTruth(world: World): Promise<Truth> {
  const truth: Truth = new Map();
  for (const kind of ["task", "project"] as SimKind[]) {
    const resp = await world.server.handle(req("GET", `/api/${PLURAL[kind]}`));
    if (resp.status !== 200) throw world.fail("harness", `listing ${PLURAL[kind]} returned ${resp.status}`);
    const rows = (resp.body as Record<string, Record<string, unknown>[]>)[PLURAL[kind]]!;
    for (const row of rows)
      truth.set(row["id"] as string, {
        kind,
        fields: { [LABEL[kind]]: row[LABEL[kind]], description: row["description"], [FLAG[kind]]: row[FLAG[kind]] },
        revision: row["revision"] as number,
      });
  }
  const list = await world.server.handle(req("GET", "/api/notes"));
  if (list.status !== 200) throw world.fail("harness", `listing notes returned ${list.status}`);
  for (const row of (list.body as { notes: Record<string, unknown>[] }).notes) {
    const detail = await world.server.handle(req("GET", `/api/notes/${row["id"]}`));
    if (detail.status !== 200) throw world.fail("harness", `reading note ${row["id"]} returned ${detail.status}`);
    const d = detail.body as Record<string, unknown>;
    truth.set(row["id"] as string, {
      kind: "note",
      fields: { path: d["path"], content: d["content"] },
      revision: d["revision"] as number,
    });
  }
  return truth;
}

export function req(method: string, path: string, params: Req["params"] = {}): Req {
  return { method, path, params, body: null, headers: { "Atlas-Sync": "1" } };
}

function clientFields(entity: {
  type: string;
  server: { fields: Record<string, unknown>; content: string | null } | null;
}): Record<string, unknown> {
  const f = entity.server!.fields;
  if (entity.type === "note") return { path: f["path"], content: entity.server!.content };
  const kind = entity.type as SimKind;
  return { [LABEL[kind]]: f[LABEL[kind]], description: f["description"], [FLAG[kind]]: f[FLAG[kind]] };
}

/** An instant is the same whatever precision the server prints it with (`.696Z` or `.696000Z`). */
const instantOrValue = (v: unknown): unknown =>
  typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : v;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(instantOrValue(a)) === JSON.stringify(instantOrValue(b));

export async function checkInvariants(world: World): Promise<void> {
  const truth = await serverTruth(world);
  const rec = world.rec;
  // 0. a retry is byte-identical, with the same idempotency key
  if (rec.selfInflicted.length) throw world.fail("idempotency_key_stability", rec.selfInflicted.slice(0, 3).join("; "));
  // 1. convergence
  for (const client of world.clients) {
    if (client.halted) continue;
    await checkCursorSafety(world, client);
    const state = client.store.peek();
    const live = [...state.entities.values()].filter((e) => !e.deleted && e.server && e.type !== "reminder");
    for (const [id, want] of truth) {
      const local = state.entities.get(id);
      if (!local || local.deleted || !local.server || !same(clientFields(local), want.fields) || local.server.revision !== want.revision)
        throw world.fail(
          "convergence",
          `${client.cid} disagrees with the server about ${want.kind} ${id}: server ${JSON.stringify(want.fields)} rev ${want.revision}, client ${JSON.stringify(local && { deleted: local.deleted, rev: local.server?.revision, fields: local.server && clientFields(local) })}`,
        );
    }
    for (const e of live)
      if (!truth.has(e.id))
        throw world.fail("convergence", `${client.cid} still shows ${e.type} ${e.id} which the server no longer lists`);
    // the user's view equals the mirror once nothing is pending
    const status = await client.engine.getStatus();
    if (status.pending === 0) {
      for (const view of await client.engine.views()) {
        const entity = state.entities.get(view.id)!;
        if (view.deleted !== entity.deleted)
          throw world.fail("convergence", `${client.cid}: the view of ${view.id} disagrees with the mirror about deletion`);
      }
    }
  }
  // 2. what the server acknowledged was applied: the answer shows exactly what was sent
  for (const { cid, op, status, body } of rec.acks) {
    const b = body as Record<string, unknown> | null;
    if (!b || typeof b !== "object") continue;
    if (op.type === "note") {
      if (op.action === "create" && "content" in b && b["content"] !== op.fields["content"])
        throw world.fail("no_acknowledged_loss", `${cid} was acknowledged for creating ${op.id} but the response holds other text`);
      if (op.action === "put" && typeof b["content"] === "string") {
        const present = new Set((b["content"] as string).split("\n"));
        const missing = [...markers(op.content)].filter((m) => !rec.removed.has(m) && !present.has(m));
        if (missing.length)
          throw world.fail("no_acknowledged_loss", `${cid} was acknowledged (${status}) for save ${op.id} but the text the server returned lacks ${JSON.stringify(missing)}`);
      }
      continue;
    }
    if (op.action === "create" || op.action === "patch") {
      const held = new Set(
        (((b["sync"] as { conflicts?: { field: string }[] } | undefined)?.conflicts) ?? []).map((c) => c.field),
      );
      for (const [name, value] of Object.entries(op.fields))
        if (!held.has(name) && !same(b[name] ?? null, value ?? null))
          throw world.fail(
            "no_acknowledged_loss",
            `${cid} was acknowledged for ${op.id} (${op.action}, ${status}) but the response shows ${name}=${JSON.stringify(b[name])}, not the ${JSON.stringify(value)} it sent`,
          );
    }
  }
  // 3. revision identifies state
  const seen = new Map<string, unknown>();
  for (const { op, body } of rec.acks) {
    const b = body as Record<string, unknown> | null;
    if (!b || typeof b !== "object" || !("id" in b) || op.action === "delete") continue;
    const state =
      op.type === "note" ? { path: b["path"], hash: b["content_hash"] } : op.type === "resolution" ? null : fieldsOf(op.type as SimKind, b);
    if (state === null) continue;
    const key = `${String(b["id"])}@${String(b["revision"])}`;
    const prev = seen.get(key);
    if (prev !== undefined && !same(prev, state))
      throw world.fail("revision_identifies_state", `${op.type} ${String(b["id"])} revision ${String(b["revision"])} was acknowledged with two states: ${JSON.stringify(prev)} and ${JSON.stringify(state)}`);
    seen.set(key, state);
  }
  // 4. no duplicates
  const creates = new Set(rec.acks.filter((a) => a.op.action === "create").map((a) => a.op.id));
  const copies = new Set(rec.conflictCopies.map((c) => c.copy["id"]));
  const announced = new Set(await world.server.allEntityIds());
  const slack = world.clients
    .filter((c) => rec.halts.get(c.cid) === "signed_out")
    .reduce(async (accP, c) => (await accP) + (await queueLength(c, ["create", "put"])), Promise.resolve(0));
  const expected = creates.size + copies.size;
  const allowed = expected + (await slack);
  if (!(expected <= announced.size && announced.size <= allowed))
    throw world.fail(
      "no_duplicates",
      `${creates.size} creates were acknowledged and ${copies.size} conflict copies were reported, but the server holds ${announced.size} entities (a retried create or conflict made a second entity)`,
    );
  // 5. no resurrection
  const deletedAcked = new Set(rec.acks.filter((a) => a.op.action === "delete").map((a) => a.op.entityId));
  const restoredAcked = new Set(rec.acks.filter((a) => a.op.action === "restore").map((a) => a.op.entityId));
  const editedAcked = new Set(rec.acks.filter((a) => ["patch", "restore", "put"].includes(a.op.action)).map((a) => a.op.entityId));
  for (const id of deletedAcked) {
    if (editedAcked.has(id)) continue; // edit wins over delete (rule 4)
    if (truth.has(id) && !restoredAcked.has(id))
      throw world.fail("no_resurrection", `${id} was deleted (acknowledged) and never restored, but the server lists it live`);
  }
  checkSyncWorld(world);
  await checkNotes(world, truth);
  if (world.cfg.resolutions) await checkResolutions(world);
  checkLogs(world);
  const model = world.model();
  if (model) checkModelHistory(world, model);
  checkDevices(world);
}

async function queueLength(client: SimClient, actions: string[]): Promise<number> {
  const queue = await client.store.transaction(async (tx) => tx.listQueue());
  return queue.filter((o) => actions.includes(o.action)).length;
}

function fieldsOf(kind: SimKind, b: Record<string, unknown>): Record<string, unknown> {
  return { [LABEL[kind]]: b[LABEL[kind]], description: b["description"], [FLAG[kind]]: b[FLAG[kind]] };
}

function checkSyncWorld(world: World): void {
  const rec = world.rec;
  for (const { cid, op, status, code } of rec.refusals) {
    if (op.action === "restore" && status === 404) continue;
    const expected: Record<string, string[]> = {
      conflict: ["patch", "put"],
      edit_wins: ["delete"],
      path_exists: ["move"],
      note_deleted: ["move"],
    };
    if (!code || !expected[code]?.includes(op.action))
      throw world.fail(
        "unexpected_rejection",
        `${cid} was refused ${op.action} ${op.id.slice(0, 8)} with ${status} ${JSON.stringify(code)}: only a text conflict, a stale delete (edit wins) and, for notes, a taken path or a move of a deleted note are expected`,
      );
  }
  for (const client of world.clients) {
    if (client.protocol === 1) continue;
    if (rec.halts.get(client.cid) !== "update_required" || client.sentTotal() !== client.sentAtHalt)
      throw world.fail(
        "stop_on_426",
        `the unsupported client sent ${client.sentTotal()} requests, halted=${rec.halts.get(client.cid)} (sent ${client.sentAtHalt} when it halted); it must stop at the first 426 and send nothing after`,
      );
    if (rec.acks.some((a) => a.cid === client.cid)) throw world.fail("stop_on_426", "an unsupported client had a write acknowledged");
  }
}

function checkDevices(world: World): void {
  const server = world.server as unknown as { servedAfterRevoke?: string[] };
  if (server.servedAfterRevoke?.length)
    throw world.fail("revoked_never_served", `requests of a revoked device were answered 2xx: ${server.servedAfterRevoke.slice(0, 3).join(", ")}`);
  const cid = world.cfg.revokeClient;
  if (!cid) return;
  const client = world.clients.find((c) => c.cid === cid)!;
  if (world.rec.halts.get(cid) !== "signed_out" || client.sentTotal() !== client.sentAtHalt)
    throw world.fail(
      "stop_on_revoked",
      `${cid} sent ${client.sentTotal()} requests, halted=${world.rec.halts.get(cid)} (sent ${client.sentAtHalt} at the halt): it must stop at the first token_revoked and send nothing after`,
    );
}

function checkLogs(world: World): void {
  const text = /(task|project):c\d+-\d+|\bd:c\d+-\d+|\bm:c\d+-\d+|# Title/;
  for (const line of world.rec.logLines) {
    const blob = JSON.stringify(line);
    if (text.test(blob)) throw world.fail("log_has_no_content", `a log line carries user content: ${blob.slice(0, 200)}`);
  }
}

function checkModelHistory(world: World, model: ModelServer): void {
  const applied = new Map<string, number>();
  for (const e of model.history) {
    if (e.opId !== "?") {
      const n = (applied.get(e.opId) ?? 0) + 1;
      applied.set(e.opId, n);
      if (n > 1) throw world.fail("no_duplicates", `operation ${e.opId} was applied ${n} times`);
    }
    if (e.event === "resurrect") throw world.fail("no_resurrection", `${e.entityId} was brought back by ${e.opId} without a restore`);
  }
  const text = new Set(["title", "name", "description"]);
  for (const e of model.history) {
    if (e.event === "patch" || e.event === "revive")
      for (const [name, changedAt] of e.writes)
        if (text.has(name) && e.base !== null && changedAt > e.base)
          throw world.fail("no_silent_text_loss", `${e.opId} overwrote text field ${name} of ${e.entityId}, which changed at revision ${changedAt} after its base ${e.base}`);
    if (e.event === "delete" && e.base !== null && e.revisionBefore !== null && e.base < e.revisionBefore)
      throw world.fail("edit_wins", `${e.opId} deleted ${e.entityId} on base ${e.base} although it was edited up to revision ${e.revisionBefore}`);
  }
  for (const e of model.history) {
    if (e.kind !== "note" || !["write", "merge", "revive"].includes(e.event)) continue;
    const ex = e.extra as { theirs?: string | null; ours: string; after: string; base_text?: string | null; copy?: boolean };
    const theirs = ex.theirs ?? "";
    const base = ex.base_text ?? theirs;
    const mTheirs = markers(theirs);
    const mAfter = markers(ex.after);
    const mBase = markers(base);
    const mOurs = markers(ex.ours);
    const dropped = [...mTheirs].filter((m) => !mAfter.has(m) && !(mBase.has(m) && !mOurs.has(m)));
    if (dropped.length)
      throw world.fail("no_silent_overwrite", `${e.opId} (${e.event}) removed lines ${JSON.stringify(dropped)} of ${e.entityId} that it had not removed from its base`);
    if (!ex.copy) {
      const lost = [...mOurs].filter((m) => !mBase.has(m) && !mAfter.has(m));
      if (lost.length)
        throw world.fail("no_acknowledged_note_loss", `${e.opId} (${e.event}) dropped its own additions ${JSON.stringify(lost)}`);
    }
  }
  for (const { cid, op, status } of world.rec.acks) {
    if (op.action !== "create" && (applied.get(op.key) ?? 0) <= 1) continue;
    if ((applied.get(op.key) ?? 0) !== 1)
      throw world.fail("no_acknowledged_loss", `${cid} was acknowledged (${status}) for ${op.id} (${op.action}) but the server applied it ${applied.get(op.key) ?? 0} times`);
  }
}

async function checkNotes(world: World, truth: Truth): Promise<void> {
  const rec = world.rec;
  for (const { cid, op, copy } of rec.conflictCopies) {
    const want = op.content ?? (op.fields["content"] as string);
    if (copy["content_hash"] !== sha(want))
      throw world.fail("conflict_copy_has_losing_text", `${cid}: the copy ${String(copy["id"])} of ${op.id} reports another hash`);
    const first = await world.server.handle(req("GET", `/api/notes/${String(copy["id"])}/history/1`));
    if (first.status !== 200 || (first.body as { content: string }).content !== want)
      throw world.fail("conflict_copy_has_losing_text", `${cid}: the conflict copy ${String(copy["id"])} of ${op.id} does not hold the text that lost (status ${first.status})`);
  }
  const seenPaths = new Map<string, string>();
  for (const [id, t] of truth) {
    if (t.kind !== "note") continue;
    const path = String(t.fields["path"]);
    const problem = checkPortable(path);
    if (problem) throw world.fail("portable_paths", `live note ${id} has path ${JSON.stringify(path)}: ${problem.detail}`);
    const other = seenPaths.get(foldPath(path));
    if (other !== undefined && other !== id)
      throw world.fail("unique_paths", `notes ${other} and ${id} have paths that differ only by case or normalisation: ${JSON.stringify(path)}`);
    seenPaths.set(foldPath(path), id);
  }
  // nothing a user typed has disappeared, unless a user removed it; text kept as a client problem
  // (a rejected save, an unmergeable rebase) counts as kept: both versions are preserved as data
  const universe = new Set<string>();
  for (const id of await world.server.allEntityIds()) {
    const live = truth.get(id);
    if (live) {
      if (live.kind === "note") markers(String(live.fields["content"])).forEach((m) => universe.add(m));
      continue;
    }
    const listing = await world.server.handle(req("GET", `/api/notes/${id}/history`));
    if (listing.status !== 200) continue;
    const revisions = (listing.body as { revisions: { revision: number }[] }).revisions;
    if (!revisions.length) continue;
    const newest = Math.max(...revisions.map((r) => r.revision));
    const last = await world.server.handle(req("GET", `/api/notes/${id}/history/${newest}`));
    if (last.status === 200) markers((last.body as { content: string }).content).forEach((m) => universe.add(m));
  }
  for (const client of world.clients) {
    const problems: Problem[] = [...client.store.peek().problems.values()];
    for (const p of problems) {
      markers(p.mineText).forEach((m) => universe.add(m));
      markers(p.mineLatestText).forEach((m) => universe.add(m));
    }
    // a halted client (revoked) keeps its unsent text locally
    for (const draft of client.store.peek().drafts.values()) markers(draft.text).forEach((m) => universe.add(m));
    for (const op of client.store.peek().queue.values()) {
      markers(op.content).forEach((m) => universe.add(m));
      markers(typeof op.fields["content"] === "string" ? (op.fields["content"] as string) : null).forEach((m) => universe.add(m));
    }
  }
  const lost = [...rec.added].filter((m) => !universe.has(m) && !rec.removed.has(m)).sort();
  if (lost.length)
    throw world.fail("no_acknowledged_note_loss", `lines users typed are in no note and were removed by no edit: ${JSON.stringify(lost)} (${lost.map((m) => rec.origin.get(m)).join("; ")})`);
}

// --- resolutions and undo -----------------------------------------------------------------------

const ONE_PER_REVISION = new Set(["simple_later_wins", "path_later_wins", "edit_wins_over_delete", "path_collision"]);
const LOSER_RULES = new Set(["simple_later_wins", "path_later_wins", "undo"]);
const UNDO_REFUSALS = new Set(["conflict", "entity_deleted", "already_undone", "not_undoable", "path_exists"]);
const TEXT = /(task|project):c\d+-\d+|\bd:c\d+-\d+|\bm:c\d+-\d+|# Title/;

export async function fetchLog(world: World): Promise<Record<string, unknown>[]> {
  const entries: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 1000; i++) {
    const params: Req["params"] = { limit: 200 };
    if (cursor !== null) params["cursor"] = cursor;
    const resp = await world.server.handle(req("GET", "/api/sync/resolutions", params));
    if (resp.status !== 200) throw world.fail("harness", `listing the resolution log returned ${resp.status}`);
    const body = resp.body as { resolutions: Record<string, unknown>[]; next_cursor: string | null };
    entries.push(...body.resolutions);
    cursor = body.next_cursor;
    if (cursor === null) return entries;
  }
  throw world.fail("harness", "the resolution log did not end");
}

async function checkResolutions(world: World): Promise<void> {
  const rec = world.rec;
  const log = await fetchLog(world);
  const byId = new Map(log.map((e) => [e["id"] as string, e]));
  if (byId.size !== log.length) throw world.fail("resolution_logged_once", "the log lists an entry id twice");
  for (const entry of log) {
    const blob = JSON.stringify(entry);
    if (TEXT.test(blob) || (entry["has_loser"] && !LOSER_RULES.has(entry["rule"] as string)))
      throw world.fail("log_has_no_text", `entry ${String(entry["id"])} (${String(entry["rule"])}) keeps text: ${blob.slice(0, 200)}`);
  }
  const writes = new Map<string, string>();
  for (const entry of log) {
    if (ONE_PER_REVISION.has(entry["rule"] as string) && entry["kept_revision"] !== null) {
      const key = JSON.stringify([entry["entity_id"], entry["rule"], entry["field"], entry["kept_revision"]]);
      if (writes.has(key))
        throw world.fail("resolution_logged_once", `entries ${writes.get(key)} and ${String(entry["id"])} both record ${key}: one write was logged twice`);
      writes.set(key, entry["id"] as string);
    }
  }
  for (const [rid, { opKey, out }] of rec.seenResolutions) {
    const entry = byId.get(rid);
    if (!entry) throw world.fail("resolution_logged_once", `${opKey} was answered with resolution ${rid} (${String(out["rule"])}) that the log lacks`);
    if (!same([entry["rule"], entry["field"], entry["kept_revision"]], [out["rule"], out["field"] ?? null, out["kept_revision"] ?? null]))
      throw world.fail("resolution_logged_once", `${opKey} was told ${JSON.stringify(out)} but the log holds ${String(entry["rule"])} ${String(entry["field"])} revision ${String(entry["kept_revision"])}`);
  }
  const revoked = new Set([...rec.halts.entries()].filter(([, k]) => k === "signed_out").map(([c]) => c));
  for (const entry of log) {
    if (!rec.seenResolutions.has(entry["id"] as string) && revoked.size === 0) {
      const name = entry["rule"] === "undo" ? "undo_idempotent" : "no_log_without_write";
      throw world.fail(name, `log entry ${String(entry["id"])} (${String(entry["rule"])} of ${String(entry["entity_id"])} at revision ${String(entry["kept_revision"])}) was reported to no client: no acknowledged write produced it`);
    }
  }
  const undoOf = new Map<string, string[]>();
  for (const entry of log)
    if (entry["rule"] === "undo" && entry["undoes_id"])
      undoOf.set(entry["undoes_id"] as string, [...(undoOf.get(entry["undoes_id"] as string) ?? []), entry["id"] as string]);
  for (const [target, ids] of undoOf) if (ids.length > 1) throw world.fail("undo_once", `resolution ${target} has undo entries ${JSON.stringify(ids)}`);
  for (const entry of log) {
    if (entry["rule"] === "undo") continue;
    const count = undoOf.get(entry["id"] as string)?.length ?? 0;
    if ((entry["undone_at"] !== null) !== (count === 1))
      throw world.fail("undo_logged", `resolution ${String(entry["id"])} is marked undone=${entry["undone_at"] !== null} but has ${count} undo entries`);
  }
  for (const { cid, op, body } of rec.undos) {
    const undo = body["undo"] as Record<string, unknown>;
    const entry = undo?.["id"] ? byId.get(undo["id"] as string) : undefined;
    if (!entry || entry["undoes_id"] !== op.entityId)
      throw world.fail("undo_logged", `${cid} was answered ${JSON.stringify(undo)} for undo ${op.id} but the log holds no undo entry of ${op.entityId}`);
    if (body["applied"] && rec.winners.has(op.entityId) && !same(entry["loser"], rec.winners.get(op.entityId)))
      throw world.fail("undo_never_overwrites_newer", `undo ${op.id} replaced ${JSON.stringify(entry["loser"])} but the winning write of ${op.entityId} had stored ${JSON.stringify(rec.winners.get(op.entityId))}: a newer value was overwritten`);
  }
  for (const { cid, op, status, code } of rec.undoRefusals)
    if (!code || !UNDO_REFUSALS.has(code)) throw world.fail("unexpected_rejection", `${cid} was refused undo ${op.id} with ${status} ${JSON.stringify(code)}`);
  const truthUndone = new Map(log.map((e) => [e["id"] as string, e["undone_at"] !== null]));
  for (const client of world.clients) {
    if (client.halted) continue;
    const held: ResolutionRecord[] = [...client.store.peek().resolutions.values()];
    const mine = new Map(held.map((r) => [r.id, r.undone_at !== null]));
    const missing = [...truthUndone.keys()].filter((id) => !mine.has(id));
    const differing = [...mine.keys()].filter((id) => truthUndone.has(id) && mine.get(id) !== truthUndone.get(id));
    const unknown = [...mine.keys()].filter((id) => !truthUndone.has(id));
    if (missing.length || differing.length || unknown.length)
      throw world.fail("resolutions_converge", `${client.cid} disagrees with the server's log: missing ${JSON.stringify(missing.slice(0, 5))}, differing ${JSON.stringify(differing.slice(0, 5))}, unknown ${JSON.stringify(unknown.slice(0, 5))}`);
  }
  const model = world.model();
  if (model) {
    if (model.resLog.length !== model.generated)
      throw world.fail("resolution_logged_once", `${model.generated} resolutions were generated by writes but the log holds ${model.resLog.length} rows`);
    for (const t of model.undoTruth) {
      const ok = "winner_path" in t ? same(t["before"], t["winner_path"]) : (t["field_revision_before"] as number) <= (t["kept_revision"] as number);
      if (!ok)
        throw world.fail("undo_never_overwrites_newer", `undo of ${String(t["resolution"])} replaced ${JSON.stringify(t["before"])} although the field had changed (revision ${String(t["field_revision_before"])}) after the resolution (revision ${String(t["kept_revision"])})`);
    }
  }
}

/** Another pull+push round on a quiescent system changes nothing. */
export async function checkIdempotence(world: World): Promise<void> {
  const beforeHead = await world.server.head();
  const snapshot = () =>
    JSON.stringify(
      world.clients.map((c) => [...c.store.peek().entities.values()].map((e) => [e.id, e.server?.revision, e.deleted])),
    );
  const before = snapshot();
  for (const client of world.clients) client.engine.requestPull();
  for (let i = 0; i < 60; i++) {
    world.events.now += 10;
    await world.events.runDue();
    await world.settle();
    for (const client of world.clients) await client.tick();
    await world.settle();
  }
  if ((await world.server.head()) !== beforeHead || snapshot() !== before)
    throw world.fail("idempotence", "an extra pull+push round on a quiescent system changed state");
}
