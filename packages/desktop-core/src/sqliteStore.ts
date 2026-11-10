import type { Json, LocalEntity, LocalStore, NoteDraft, Problem, QueueOp, ResolutionRecord, StoreTx } from "../../sync-core/src/index.ts";
import type { DbOp, RowDb, Table } from "./ports.ts";

/**
 * The sync-core {@link LocalStore} over the per-row {@link RowDb} port (SYNC-09a, ADR-0069).
 *
 * One transaction of the engine is ONE `RowDb.commit` call: writes are buffered in an overlay,
 * reads see the committed rows plus the overlay, and the commit applies the buffered rows in a
 * single SQLite transaction on the host. So "apply a page of changes and advance the cursor" (the
 * engine's `commitPage`) is atomic and durable exactly as far as SQLite is, a failed `fn` writes
 * nothing, and a crash between buffering and commit loses the whole transaction (never half of it).
 * Rows are written one by one (`put`/`del`): the cost of a transaction is proportional to what it
 * changed, never to the size of the database (the spike's whole-state store was quadratic, S2b).
 *
 * Transactions never overlap (a promise chain), as `LocalStore` requires.
 */
export class SqliteLocalStore implements LocalStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: RowDb) {}

  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const overlay = new Overlay();
      const result = await fn(this.tx(overlay));
      const ops = overlay.ops();
      if (ops.length > 0) await this.db.commit(ops);
      return result;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private tx(o: Overlay): StoreTx {
    const db = this.db;
    const get = async <T>(table: Table, key: string): Promise<T | undefined> => {
      const staged = o.get(table, key);
      if (staged !== undefined) return staged === null ? undefined : (JSON.parse(staged.value) as T);
      const raw = await db.get(table, key);
      return raw === null ? undefined : (JSON.parse(raw) as T);
    };
    const list = async <T>(table: Table, keyOf: (v: T) => string, ordOf?: (v: T) => number): Promise<T[]> => {
      const rows = (await db.list(table)).map((r) => JSON.parse(r) as T);
      if (!o.touched(table)) return rows;
      const merged = new Map<string, T>();
      if (!o.cleared(table)) for (const row of rows) merged.set(keyOf(row), row);
      for (const [key, staged] of o.rows(table)) {
        if (staged === null) merged.delete(key);
        else merged.set(key, JSON.parse(staged.value) as T);
      }
      const out = [...merged.values()];
      if (ordOf) out.sort((a, b) => ordOf(a) - ordOf(b));
      return out;
    };
    const put = (table: Table, key: string, value: unknown, extra: { ord?: number; kind?: string } = {}) =>
      o.put(table, key, JSON.stringify(value), extra.ord ?? 0, extra.kind);
    return {
      getEntity: (id) => get<LocalEntity>("entities", id),
      putEntity: async (e) => put("entities", e.id, e, { kind: e.type }),
      removeEntity: async (id) => o.del("entities", id),
      listEntities: () => list<LocalEntity>("entities", (e) => e.id),

      listQueue: () => list<QueueOp>("queue", (q) => q.id, (q) => q.seq),
      putOp: async (op) => put("queue", op.id, op, { ord: op.seq, kind: op.type }),
      removeOp: async (id) => o.del("queue", id),

      getMeta: <T extends Json>(key: string) => get<T>("meta", key),
      setMeta: async (key, value) => put("meta", key, value),
      removeMeta: async (key) => o.del("meta", key),

      listResolutions: () => list<ResolutionRecord>("resolutions", (r) => r.id),
      putResolution: async (r) => put("resolutions", r.id, r),
      clearResolutions: async () => o.clear("resolutions"),

      listProblems: () => list<Problem>("problems", (p) => p.id),
      putProblem: async (p) => put("problems", p.id, p),
      removeProblem: async (id) => o.del("problems", id),

      getDraft: (id) => get<NoteDraft>("drafts", id),
      putDraft: async (d) => put("drafts", d.entityId, d),
      removeDraft: async (id) => o.del("drafts", id),
    };
  }
}

interface Staged {
  value: string;
  ord: number;
  kind: string | undefined;
}

/** Writes of one transaction, in order, with last-write-wins per row and `clear` support. */
class Overlay {
  private readonly tables = new Map<Table, { cleared: boolean; rows: Map<string, Staged | null> }>();
  private readonly log: DbOp[] = [];

  private t(table: Table) {
    let t = this.tables.get(table);
    if (!t) this.tables.set(table, (t = { cleared: false, rows: new Map() }));
    return t;
  }
  touched(table: Table): boolean {
    return this.tables.has(table);
  }
  cleared(table: Table): boolean {
    return this.tables.get(table)?.cleared ?? false;
  }
  rows(table: Table): Iterable<[string, Staged | null]> {
    return this.tables.get(table)?.rows ?? [];
  }
  /** `undefined`: not touched (read the database); `null`: deleted here; else the staged row. */
  get(table: Table, key: string): Staged | null | undefined {
    const t = this.tables.get(table);
    if (!t) return undefined;
    if (t.rows.has(key)) return t.rows.get(key);
    return t.cleared ? null : undefined;
  }
  put(table: Table, key: string, value: string, ord: number, kind: string | undefined): void {
    this.t(table).rows.set(key, { value, ord, kind });
    this.log.push(kind === undefined ? { op: "put", table, key, value, ord } : { op: "put", table, key, value, ord, kind });
  }
  del(table: Table, key: string): void {
    this.t(table).rows.set(key, null);
    this.log.push({ op: "del", table, key });
  }
  clear(table: Table): void {
    const t = this.t(table);
    t.cleared = true;
    t.rows.clear();
    this.log.push({ op: "clear", table });
  }
  /** The operations to commit: every put/del/clear in the order they were made. */
  ops(): DbOp[] {
    return this.log;
  }
}
