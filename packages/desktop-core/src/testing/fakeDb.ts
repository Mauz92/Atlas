import type { DbOp, RowDb, Table } from "../ports.ts";
import { TABLES } from "../ports.ts";
import { InjectedCrash } from "../../../sync-core/src/testing/index.ts";

interface Row {
  value: string;
  ord: number;
  kind: string | undefined;
}

/** Thrown by {@link FakeRowDb} when a crash is injected: the batch is lost entirely. */
export class DbCrash extends InjectedCrash {}

/**
 * An in-memory {@link RowDb} with the host's contract: `commit` is all-or-nothing, an unknown table
 * is refused, `list` is ordered by `ord` then key, a database newer than the build is refused.
 * `persist`/`restore` model a file that survives a process restart (a "kill -9" is `crashBeforeCommit`).
 */
export class FakeRowDb implements RowDb {
  static readonly SCHEMA_VERSION = 1;
  private tables = new Map<Table, Map<string, Row>>(TABLES.map((t) => [t, new Map()]));
  userVersion = FakeRowDb.SCHEMA_VERSION;
  /** Called once per commit before it applies; return true to lose the batch. */
  crashBeforeCommit: (() => boolean) | null = null;
  commits = 0;
  opened = false;

  async open(): Promise<{ schemaVersion: number }> {
    if (this.userVersion > FakeRowDb.SCHEMA_VERSION) throw new Error("database_newer_than_app");
    this.opened = true;
    return { schemaVersion: this.userVersion };
  }

  private table(name: string): Map<string, Row> {
    const t = this.tables.get(name as Table);
    if (!t) throw new Error(`unknown_table:${name}`);
    return t;
  }

  async get(table: Table, key: string): Promise<string | null> {
    return this.table(table).get(key)?.value ?? null;
  }

  async list(table: Table): Promise<string[]> {
    return [...this.table(table).entries()]
      .sort(([ka, a], [kb, b]) => a.ord - b.ord || (ka < kb ? -1 : ka > kb ? 1 : 0))
      .map(([, r]) => r.value);
  }

  async commit(ops: DbOp[]): Promise<void> {
    for (const op of ops) this.table(op.table); // validate before touching anything
    if (this.crashBeforeCommit?.()) throw new DbCrash();
    for (const op of ops) {
      const t = this.table(op.table);
      if (op.op === "put") t.set(op.key, { value: op.value, ord: op.ord ?? 0, kind: op.kind });
      else if (op.op === "del") t.delete(op.key);
      else t.clear();
    }
    this.commits++;
  }

  /** A copy of the durable contents (what a restarted process would find in the file). */
  snapshot(): Map<Table, Map<string, Row>> {
    return new Map([...this.tables].map(([k, v]) => [k, new Map(v)]));
  }

  /** Every row of a table, parsed (assertions and the simulation's invariants). */
  dumpTable<T = unknown>(table: Table): Map<string, T> {
    return new Map([...this.table(table)].map(([k, r]) => [k, JSON.parse(r.value) as T]));
  }
}
