import type { LocalEntity, NoteDraft, Problem, QueueOp, ResolutionRecord, Json } from "../../../sync-core/src/index.ts";
import type { State } from "../../../sync-core/src/testing/memoryStore.ts";
import type { SimStore } from "../../../sync-core/sim/world.ts";
import type { StoreTx } from "../../../sync-core/src/index.ts";
import type { RowDb } from "../ports.ts";
import { SqliteLocalStore } from "../sqliteStore.ts";
import { FakeRowDb } from "./fakeDb.ts";

/** The desktop store (SQLite adapter over the row port) as a simulation client's durable store. */
export class DesktopSimStore implements SimStore {
  readonly db: FakeRowDb;
  private readonly store: SqliteLocalStore;

  constructor(wrap: (db: FakeRowDb) => RowDb = (db) => db) {
    this.db = new FakeRowDb();
    this.store = new SqliteLocalStore(wrap(this.db));
  }

  get crashBeforeCommit(): (() => boolean) | null {
    return this.db.crashBeforeCommit;
  }
  set crashBeforeCommit(hook: (() => boolean) | null) {
    this.db.crashBeforeCommit = hook;
  }

  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    return this.store.transaction(fn);
  }

  peek(): State {
    const db = this.db;
    return {
      entities: db.dumpTable<LocalEntity>("entities"),
      queue: db.dumpTable<QueueOp>("queue"),
      meta: db.dumpTable<Json>("meta"),
      resolutions: db.dumpTable<ResolutionRecord>("resolutions"),
      problems: db.dumpTable<Problem>("problems"),
      drafts: db.dumpTable<NoteDraft>("drafts"),
    };
  }
}
