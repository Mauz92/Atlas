import type { LocalStore, StoreTx } from "../ports.ts";
import type {
  Json,
  LocalEntity,
  NoteDraft,
  Problem,
  QueueOp,
  ResolutionRecord,
} from "../types.ts";

export interface State {
  entities: Map<string, LocalEntity>;
  queue: Map<string, QueueOp>;
  meta: Map<string, Json>;
  resolutions: Map<string, ResolutionRecord>;
  problems: Map<string, Problem>;
  drafts: Map<string, NoteDraft>;
}

function emptyState(): State {
  return {
    entities: new Map(),
    queue: new Map(),
    meta: new Map(),
    resolutions: new Map(),
    problems: new Map(),
    drafts: new Map(),
  };
}

function cloneState(state: State): State {
  return structuredClone(state);
}

const copy = <T>(value: T): T => structuredClone(value);

/** Thrown by {@link MemoryStore} when a crash is injected: the transaction is lost entirely. */
export class InjectedCrash extends Error {
  constructor() {
    super("injected crash: the transaction was not committed");
  }
}

/**
 * An in-memory {@link LocalStore} with real transaction semantics (a failed or crashed
 * transaction leaves no trace) and copy-on-read/write, so a caller that forgets to `put` an edit
 * fails here the way it would on SQLite. `crashBeforeCommit` models a process dying between the
 * statements of a transaction: the writes are discarded.
 */
export class MemoryStore implements LocalStore {
  private state: State = emptyState();
  private chain: Promise<unknown> = Promise.resolve();
  /** Called once per transaction before commit; return true to lose the transaction. */
  crashBeforeCommit: (() => boolean) | null = null;
  commits = 0;
  /** Durable hook: awaited with the new state BEFORE it becomes visible (a failure aborts the transaction). */
  persist: ((state: State) => Promise<void>) | null = null;

  /** Replace the contents (a host restoring what it persisted). */
  load(state: State): void {
    this.state = state;
  }

  async transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const draft = cloneState(this.state);
      const writes = { count: 0 };
      const result = await fn(this.tx(draft, writes));
      if (writes.count > 0 && this.crashBeforeCommit?.()) throw new InjectedCrash();
      if (writes.count > 0 && this.persist) await this.persist(draft);
      this.state = draft;
      this.commits++;
      return result;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** The live state, read-only by convention (cheap invariant checks). */
  peek(): State {
    return this.state;
  }

  /** A deep copy of everything stored, for assertions. */
  dump(): State {
    return cloneState(this.state);
  }

  private tx(s: State, writes: { count: number }): StoreTx {
    const w = <T>(fn: () => T): T => {
      writes.count++;
      return fn();
    };
    return {
      getEntity: async (id) => copyOrUndefined(s.entities.get(id)),
      putEntity: async (e) => w(() => void s.entities.set(e.id, copy(e))),
      removeEntity: async (id) => w(() => void s.entities.delete(id)),
      listEntities: async () => [...s.entities.values()].map(copy),
      listQueue: async () => [...s.queue.values()].sort((a, b) => a.seq - b.seq).map(copy),
      putOp: async (op) => w(() => void s.queue.set(op.id, copy(op))),
      removeOp: async (id) => w(() => void s.queue.delete(id)),
      getMeta: async <T extends Json>(key: string) => copyOrUndefined(s.meta.get(key)) as T | undefined,
      setMeta: async (key, value) => w(() => void s.meta.set(key, copy(value))),
      removeMeta: async (key) => w(() => void s.meta.delete(key)),
      listResolutions: async () => [...s.resolutions.values()].map(copy),
      putResolution: async (r) => w(() => void s.resolutions.set(r.id, copy(r))),
      clearResolutions: async () => w(() => s.resolutions.clear()),
      listProblems: async () => [...s.problems.values()].map(copy),
      putProblem: async (p) => w(() => void s.problems.set(p.id, copy(p))),
      removeProblem: async (id) => w(() => void s.problems.delete(id)),
      getDraft: async (id) => copyOrUndefined(s.drafts.get(id)),
      putDraft: async (d) => w(() => void s.drafts.set(d.entityId, copy(d))),
      removeDraft: async (id) => w(() => void s.drafts.delete(id)),
    };
  }
}

function copyOrUndefined<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : copy(value);
}
