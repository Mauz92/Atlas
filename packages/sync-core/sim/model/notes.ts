/**
 * The model server's notes (a port of `model_notes.py`): sync-mode note writes, history, the
 * three-way merge, conflict copies, edit-wins, revive, move and portable paths, as
 * `SYNC_PROTOCOL.md` 6.3 specifies. The merge is the client core's own `merge3`, so what the
 * simulation tests is the protocol around it (bases, history, retries, ordering, deletes).
 */

import { merge3 } from "../../src/merge3.ts";
import { checkPortable, foldPath, normalizeNotePath } from "../../src/portable.ts";
import { clone, error, sha, stable, type Req, type Resp } from "./common.ts";
import type { Entity, ModelServer } from "./server.ts";

const HISTORY_KEEP = 200;
const COPY_STAMP = "2000-01-01 000000";
const NOTE_SUFFIX = ".md";

type Res = Record<string, unknown>;

export class ModelNotes {
  copies = 0;
  constructor(private readonly srv: ModelServer) {}

  handle(req: Req, sync: boolean, rest: string[]): Resp {
    const method = req.method;
    if (rest.length === 0) {
      if (method === "POST") return this.syncOnly(req, sync, "note.create", () => this.create(req));
      if (method === "GET") {
        const live = [...this.srv.entities.values()].filter((e) => e.kind === "note" && !e.deleted);
        live.sort((a, b) => String(a.fields["path"]).localeCompare(String(b.fields["path"])));
        return { status: 200, body: { notes: live.map((e) => this.summary(e)), folders: [] } };
      }
    } else if (rest.length === 1) {
      const id = rest[0]!;
      if (method === "GET") {
        const note = this.entity(id);
        if (!note || note.deleted) return { status: 404, body: { detail: "Not found" } };
        return { status: 200, body: this.out(note) };
      }
      if (method === "PUT") return this.putEntry(req, sync, id);
      if (method === "DELETE") return this.deleteEntry(req, sync, id);
    } else if (rest.length === 2 && rest[1] === "move" && method === "POST") {
      return this.moveEntry(req, sync, rest[0]!);
    } else if (rest.length === 2 && rest[1] === "history" && method === "GET") {
      const note = this.entity(rest[0]!);
      if (!note) return { status: 404, body: { detail: "Not found" } };
      const rows = [...note.history.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([revision, [content, path]]) => ({
          revision,
          content_hash: sha(content),
          size_bytes: Buffer.byteLength(content),
          path,
          available: true,
        }));
      return { status: 200, body: { revisions: rows } };
    } else if (rest.length === 3 && rest[1] === "history" && method === "GET") {
      const note = this.entity(rest[0]!);
      const entry = note?.history.get(Number(rest[2]));
      if (!entry) return { status: 404, body: { detail: "Not found" } };
      const [content, path, reason] = entry;
      return {
        status: 200,
        body: {
          revision: Number(rest[2]),
          content_hash: sha(content),
          size_bytes: Buffer.byteLength(content),
          path,
          reason,
          available: true,
          content,
        },
      };
    }
    return { status: 404, body: { detail: "Not Found" } };
  }

  private syncOnly(req: Req, sync: boolean, operation: string, fn: () => Resp): Resp {
    if (!sync) return { status: 500, body: { detail: "the model only implements notes in sync mode" } };
    if (!req.headers["Idempotency-Key"]) return error(422, "idempotency_key_required");
    return this.keyed(req, operation, { ...(req.body ?? {}) }, fn);
  }

  /** Idempotency that also stores a conflict (its copy is a side effect). */
  private keyed(req: Req, operation: string, payload: unknown, fn: () => Resp): Resp {
    const srv = this.srv;
    const key = req.headers["Idempotency-Key"]!;
    const fingerprint = stable(payload);
    const stored = srv.idem.get(key);
    if (stored && !srv.bugs.ignoreIdempotency) {
      if (stored[0] !== operation || stored[1] !== fingerprint) return error(409, "idempotency_mismatch");
      let body = clone(stored[3]);
      const [, , status] = stored;
      if (status >= 200 && status < 300 && body && typeof body === "object" && "content_hash" in body) {
        const rec = body as Res;
        const note = this.entity(String(rec["id"]));
        const entry = note?.history.get(Number(rec["revision"]));
        if (entry && sha(entry[0]) === rec["content_hash"]) body = { ...rec, content: entry[0] };
      }
      return { status, body };
    }
    const resp = fn();
    const stores =
      (resp.status >= 200 && resp.status < 300) ||
      ((resp.body as Res | null)?.["error"] === "conflict" && !srv.bugs.notesConflictNotStored);
    if (!srv.bugs.ignoreIdempotency && stores) {
      let body = clone(resp.body);
      if (resp.status >= 200 && resp.status < 300 && body && typeof body === "object" && "content_hash" in body) {
        const { content: _drop, ...summary } = body as Res;
        void _drop;
        body = summary;
      }
      srv.idem.set(key, [operation, fingerprint, resp.status, body]);
    }
    return resp;
  }

  // --- helpers ------------------------------------------------------------------------------

  entity(id: string): Entity | undefined {
    const e = this.srv.entities.get(id);
    return e && e.kind === "note" ? e : undefined;
  }

  private livePaths(exclude?: string): [string, string][] {
    return [...this.srv.entities.values()]
      .filter((e) => e.kind === "note" && !e.deleted && e.id !== exclude)
      .map((e) => [e.id, String(e.fields["path"])]);
  }

  taken(path: string, exclude?: string): boolean {
    const wanted = foldPath(path);
    if (this.srv.bugs.notesIgnorePathCollisions) return this.livePaths(exclude).some(([, p]) => p === path);
    return this.livePaths(exclude).some(([, p]) => foldPath(p) === wanted);
  }

  private freePath(path: string): string {
    const stem = path.slice(0, -NOTE_SUFFIX.length);
    for (let n = 2; n < 1000; n++) {
      const candidate = `${stem} (${n})${NOTE_SUFFIX}`;
      if (!this.taken(candidate)) return candidate;
    }
    throw new Error("no free path");
  }

  private portable(path: string): Resp | null {
    const problem = checkPortable(normalizeNotePath(path));
    return problem ? error(422, "invalid_path", { detail: problem.detail, reason: problem.reason }) : null;
  }

  bump(note: Entity, content: string, path: string, reason: string): void {
    note.revision++;
    note.fields["content"] = content;
    note.fields["path"] = path;
    note.history.set(note.revision, [content, path, reason]);
    while (note.history.size > HISTORY_KEEP) note.history.delete(Math.min(...note.history.keys()));
    this.srv.record(note, "upsert");
  }

  summary(note: Entity): Res {
    const content = String(note.fields["content"]);
    return {
      id: note.id,
      path: note.fields["path"],
      revision: note.revision,
      content_hash: sha(content),
      size_bytes: Buffer.byteLength(content),
    };
  }

  private out(note: Entity, opts: { sync?: boolean; merged?: boolean; resolutions?: Res[] } = {}): Res {
    const out: Res = { ...this.summary(note), content: note.fields["content"] };
    if (opts.sync)
      out["sync"] = {
        revision: note.revision,
        resolution: opts.resolutions ?? [],
        conflicts: [],
        merged: opts.merged ?? false,
      };
    return out;
  }

  private res(rule: string, extra: { kept?: number | null; detail?: string | null; field?: string | null; loser?: unknown } = {}): Res {
    return {
      rule,
      field: extra.field ?? null,
      kept_revision: extra.kept ?? null,
      loser: extra.loser ?? null,
      detail: extra.detail ?? null,
    };
  }

  private noteEvent(req: Req, event: string, note: Entity, extra: Record<string, unknown> = {}): void {
    const opId = (req.headers["X-Sim-Op"] ?? req.headers["Idempotency-Key"] ?? "?");
    const { base, revisionBefore, ...rest } = extra as { base?: number; revisionBefore?: number };
    this.srv.history.push({
      opId: event === "conflict_copy" && opId !== "?" ? `${opId}:copy` : opId,
      event,
      kind: "note",
      entityId: note.id,
      revision: note.revision,
      base: base ?? null,
      revisionBefore: revisionBefore ?? null,
      writes: [],
      extra: rest,
    });
  }

  // --- create -------------------------------------------------------------------------------

  private create(req: Req): Resp {
    const body = { ...(req.body ?? {}) } as Res;
    const unknown = Object.keys(body).filter((k) => !["id", "path", "content"].includes(k)).sort();
    if (unknown.length) return error(422, "unknown_fields", { fields: unknown });
    const path = body["path"];
    const content = body["content"] ?? "";
    if (typeof path !== "string" || !path || typeof content !== "string")
      return { status: 422, body: { detail: "validation" } };
    const clientId = body["id"] as string | undefined;
    if (clientId !== undefined) {
      const existing = this.srv.entities.get(clientId);
      if (existing) {
        if (existing.kind === "note" && this.sameCreate(existing, path, content))
          return { status: 201, body: this.out(existing, { sync: true }) };
        return error(409, "id_exists");
      }
    }
    const refusal = this.portable(path);
    if (refusal) return refusal;
    let normalized = normalizeNotePath(path);
    let requested: string | null = null;
    if (this.taken(normalized)) {
      requested = normalized;
      normalized = this.freePath(normalized);
    }
    let noteId = clientId;
    if (noteId === undefined) {
      this.srv.nextId++;
      noteId = `n${this.srv.nextId}`;
    }
    const note = this.newNote(noteId, normalized, content);
    this.noteEvent(req, "create", note, { after: content });
    const resolutions: Res[] = [];
    if (requested !== null)
      resolutions.push(this.res("path_collision", { detail: `${requested} was taken; created ${normalized}` }));
    this.srv.res.log(req, note, resolutions, { revision: note.revision });
    return { status: 201, body: this.out(note, { sync: true, resolutions }) };
  }

  private newNote(id: string, path: string, content: string): Entity {
    const note: Entity = {
      kind: "note",
      id,
      fields: { path, content },
      revision: 1,
      deleted: false,
      lastClientTime: -1e18,
      fieldRevs: {},
      history: new Map([[1, [content, path, "create"]]]),
    };
    this.srv.entities.set(id, note);
    this.srv.record(note, "upsert");
    return note;
  }

  private sameCreate(existing: Entity, path: string, content: string): boolean {
    if (existing.deleted || existing.revision !== 1 || existing.fields["content"] !== content) return false;
    const wanted = normalizeNotePath(path);
    const stem = wanted.slice(0, -NOTE_SUFFIX.length);
    const have = String(existing.fields["path"]);
    return have === wanted || (have.startsWith(`${stem} (`) && have.endsWith(`)${NOTE_SUFFIX}`));
  }

  // --- update (the three-way merge) -------------------------------------------------------------

  private putEntry(req: Req, sync: boolean, id: string): Resp {
    if (!sync) return { status: 500, body: { detail: "the model only implements notes in sync mode" } };
    if (!req.headers["Idempotency-Key"]) return error(422, "idempotency_key_required");
    const body = { ...(req.body ?? {}) } as Res;
    if (body["base_hash"] === null || body["base_hash"] === undefined) return error(422, "base_hash_required");
    const unknown = Object.keys(body).filter((k) => !["content", "base_revision", "base_hash"].includes(k)).sort();
    if (unknown.length) return error(422, "unknown_fields", { fields: unknown });
    return this.keyed(req, "note.update", { note_id: id, ...body }, () => this.put(req, id));
  }

  private conflict(req: Req, note: Entity, content: string, reason: string, resolutions: Res[] = []): Resp {
    this.copies++;
    const stem = String(note.fields["path"]).slice(0, -NOTE_SUFFIX.length);
    const suffix = this.copies === 1 ? "" : ` ${this.copies}`;
    let path = `${stem} (conflict ${COPY_STAMP}${suffix})${NOTE_SUFFIX}`;
    while (this.taken(path)) {
      this.copies++;
      path = `${stem} (conflict ${COPY_STAMP} ${this.copies})${NOTE_SUFFIX}`;
    }
    this.srv.nextId++;
    const saved = this.srv.bugs.notesConflictCopyTruncated ? content.slice(0, Math.floor(content.length / 2)) : content;
    const copy = this.newNote(`n${this.srv.nextId}`, path, saved);
    this.noteEvent(req, "conflict_copy", copy, { after: content, of: note.id });
    this.srv.res.log(req, note, resolutions, { revision: note.revision });
    return {
      status: 409,
      body: {
        error: "conflict",
        reason,
        current_revision: note.revision,
        current_hash: sha(String(note.fields["content"])),
        conflicts: [{ field: "content", reason: "text_conflict", server_revision: note.revision, server_value: null }],
        conflict_copy: { id: copy.id, path: copy.fields["path"], revision: copy.revision, content_hash: sha(content) },
        resolution: resolutions,
      },
    };
  }

  private historyText(note: Entity, revision: number, expectHash: string): string | null {
    const entry = note.history.get(revision);
    return !entry || sha(entry[0]) !== expectHash ? null : entry[0];
  }

  private put(req: Req, id: string): Resp {
    const srv = this.srv;
    const body = req.body as Res;
    const content = body["content"] as string;
    const base = Number(body["base_revision"]);
    const baseHash = body["base_hash"] as string;
    const note = this.entity(id);
    if (!note) return error(404, "not_found");
    if (base > note.revision)
      return error(409, "stale", { current_revision: note.revision, current_hash: sha(String(note.fields["content"])) });
    if (note.deleted) return this.revive(req, note, content, base, baseHash);
    const current = String(note.fields["content"]);
    const before = note.revision;
    if (base === note.revision) {
      if (baseHash !== sha(current)) return this.conflict(req, note, content, "base_unavailable");
      if (content === current) return { status: 200, body: this.out(note, { sync: true }) };
      if (srv.bugs.notesDropAcknowledgedWrite && srv.patches % 4 === 3) {
        srv.patches++;
        return { status: 200, body: this.out(note, { sync: true }) };
      }
      srv.patches++;
      this.bump(note, content, String(note.fields["path"]), "write");
      this.noteEvent(req, "write", note, { base, revisionBefore: before, theirs: current, ours: content, after: content, base_text: current });
      return { status: 200, body: this.out(note, { sync: true }) };
    }
    const baseText = this.historyText(note, base, baseHash);
    if (baseText === null) return this.conflict(req, note, content, "base_unavailable");
    if (content === baseText) return { status: 200, body: this.out(note, { sync: true, merged: current !== content }) };
    let mergedText: string;
    if (srv.bugs.notesOverwriteOnStale) mergedText = content;
    else if (srv.bugs.notesMergeDropsOurs) mergedText = current;
    else {
      const result = merge3(baseText, current, content);
      if (result.text === null) return this.conflict(req, note, content, result.reason ?? "overlap");
      mergedText = result.text;
    }
    const resolution = [this.res("note_merged", { kept: note.revision })];
    if (mergedText === current) {
      srv.res.log(req, note, resolution, { revision: note.revision });
      return { status: 200, body: this.out(note, { sync: true, merged: content !== mergedText, resolutions: resolution }) };
    }
    this.bump(note, mergedText, String(note.fields["path"]), "merge");
    this.noteEvent(req, "merge", note, { base, revisionBefore: before, theirs: current, ours: content, after: mergedText, base_text: baseText });
    srv.res.log(req, note, resolution, { revision: note.revision });
    return { status: 200, body: this.out(note, { sync: true, merged: mergedText !== content, resolutions: resolution }) };
  }

  private revive(req: Req, note: Entity, content: string, base: number, baseHash: string): Resp {
    if (this.srv.bugs.noRevive) return error(404, "not_found");
    const resolutions: Res[] = [this.res("edit_wins_over_delete")];
    const last = this.historyText(note, note.revision, sha(String(note.fields["content"])));
    let text = content;
    let copyOf: string | null = null;
    if (last !== null && baseHash !== sha(String(note.fields["content"]))) {
      const baseText = this.historyText(note, base, baseHash);
      const merged = baseText !== null ? merge3(baseText, last, content) : null;
      if (merged && merged.text !== null) {
        text = merged.text;
        resolutions.push(this.res("note_merged", { kept: note.revision }));
      } else {
        text = last;
        copyOf = content;
      }
    }
    let path = String(note.fields["path"]);
    if (this.taken(path)) {
      const original = path;
      path = this.freePath(path);
      resolutions.push(this.res("path_collision", { detail: `${original} was taken; restored ${path}` }));
    }
    const before = note.revision;
    note.deleted = false;
    let knownBase: string | null = baseHash === sha(String(note.fields["content"])) ? last : null;
    if (knownBase === null) knownBase = this.historyText(note, base, baseHash);
    this.bump(note, text, path, "revive");
    this.noteEvent(req, "revive", note, {
      base, revisionBefore: before, ours: content, after: text, theirs: last, base_text: knownBase, copy: copyOf !== null,
    });
    if (copyOf !== null) return this.conflict(req, note, copyOf, "overlap", resolutions);
    this.srv.res.log(req, note, resolutions, { revision: note.revision });
    return { status: 200, body: this.out(note, { sync: true, merged: text !== content, resolutions }) };
  }

  // --- delete ---------------------------------------------------------------------------------

  private deleteEntry(req: Req, sync: boolean, id: string): Resp {
    if (!sync) return { status: 500, body: { detail: "the model only implements notes in sync mode" } };
    if (req.params["base_revision"] === undefined) return error(422, "base_revision_required");
    if (!req.headers["Idempotency-Key"]) return error(422, "idempotency_key_required");
    return this.keyed(req, "note.delete", { note_id: id }, () => this.delete(req, id));
  }

  private delete(req: Req, id: string): Resp {
    const note = this.entity(id);
    if (!note) return error(404, "not_found");
    if (note.deleted) return { status: 204, body: null };
    const base = Number(req.params["base_revision"]);
    if (base > note.revision)
      return error(409, "stale", { current_revision: note.revision, current_hash: sha(String(note.fields["content"])) });
    if (base < note.revision && !this.srv.bugs.staleDeleteWins)
      return error(409, "edit_wins", {
        current_revision: note.revision,
        entity: this.summary(note),
        resolution: [{ rule: "edit_wins_over_delete" }],
      });
    const before = note.revision;
    note.deleted = true;
    note.revision++;
    note.history.set(note.revision, [String(note.fields["content"]), String(note.fields["path"]), "delete"]);
    this.srv.record(note, "delete");
    this.noteEvent(req, "delete", note, { base, revisionBefore: before });
    return { status: 204, body: null };
  }

  // --- move -----------------------------------------------------------------------------------

  private moveEntry(req: Req, sync: boolean, id: string): Resp {
    if (!sync) return { status: 500, body: { detail: "the model only implements notes in sync mode" } };
    const body = { ...(req.body ?? {}) } as Res;
    if (body["base_revision"] === undefined || body["base_revision"] === null) return error(422, "base_revision_required");
    if (!req.headers["Idempotency-Key"]) return error(422, "idempotency_key_required");
    const unknown = Object.keys(body).filter((k) => !["path", "base_revision"].includes(k)).sort();
    if (unknown.length) return error(422, "unknown_fields", { fields: unknown });
    return this.keyed(req, "note.move", { note_id: id, ...body }, () => this.move(req, id));
  }

  private move(req: Req, id: string): Resp {
    const body = req.body as Res;
    const base = Number(body["base_revision"]);
    const refusal = this.portable(String(body["path"]));
    if (refusal) return refusal;
    const note = this.entity(id);
    if (!note) return error(404, "not_found");
    if (note.deleted) return error(409, "note_deleted");
    if (base > note.revision)
      return error(409, "stale", { current_revision: note.revision, current_hash: sha(String(note.fields["content"])) });
    const normalized = normalizeNotePath(String(body["path"]));
    const resolutions: Res[] = [];
    if (base < note.revision && normalized !== note.fields["path"]) {
      const entry = note.history.get(base);
      if (entry && entry[1] !== note.fields["path"])
        resolutions.push(
          this.res("path_later_wins", {
            kept: note.revision + 1,
            field: "path",
            loser: note.fields["path"],
            detail: `was moved to ${String(note.fields["path"])} elsewhere; now ${normalized}`,
          }),
        );
    }
    if (normalized === note.fields["path"])
      return { status: 200, body: this.out(note, { sync: true, resolutions }) };
    if (this.taken(normalized, note.id)) return error(409, "path_exists");
    const before = note.revision;
    this.bump(note, String(note.fields["content"]), normalized, "move");
    this.noteEvent(req, "move", note, { base, revisionBefore: before });
    this.srv.res.log(req, note, resolutions, { revision: note.revision });
    return { status: 200, body: this.out(note, { sync: true, resolutions }) };
  }

  feedData(note: Entity): Res {
    const content = String(note.fields["content"]);
    return {
      id: note.id,
      revision: note.revision,
      deleted_at: note.deleted ? "deleted" : null,
      path: note.fields["path"],
      content_hash: sha(content),
      size_bytes: Buffer.byteLength(content),
    };
  }
}

const STAMP = /\(conflict \d{4}-\d\d-\d\d \d{6}( \d+)?\)/;
export const stripStamp = (path: string): string => path.replace(STAMP, "(conflict)");
