import type { LocalStore, StoreTx } from "../ports.ts";
import { MemoryStore, type State } from "../testing/memoryStore.ts";

/** The shape of the web app's existing durable store (`apps/web/src/lib/queueStorage.ts`). */
export interface KeyValue {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

const KEY = "atlas-sync-core-state";
const VERSION = 1;

function serialise(state: State): string {
  return JSON.stringify({
    version: VERSION,
    entities: [...state.entities],
    queue: [...state.queue],
    meta: [...state.meta],
    resolutions: [...state.resolutions],
    problems: [...state.problems],
    drafts: [...state.drafts],
  });
}

function deserialise(raw: string): State | null {
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;
    if (d["version"] !== VERSION) return null;
    const m = <T>(k: string) => new Map(d[k] as [string, T][]);
    return {
      entities: m("entities"), queue: m("queue"), meta: m("meta"),
      resolutions: m("resolutions"), problems: m("problems"), drafts: m("drafts"),
    };
  } catch {
    return null;
  }
}

/**
 * A {@link LocalStore} that keeps the whole state as one JSON value in a key-value store
 * (IndexedDB/localStorage wrapper of the web app). One write per transaction, so it is atomic
 * as far as the backing store's single write is. Suited to the web app's modest data; the desktop
 * client uses SQLite (SYNC-09). A state it cannot read is treated as empty (re-pulled from the server).
 */
export class KeyValueLocalStore implements LocalStore {
  private readonly inner = new MemoryStore();
  private ready: Promise<void> | null = null;

  constructor(private readonly kv: KeyValue) {
    this.inner.persist = async (state) => kv.write(KEY, serialise(state));
  }

  private load(): Promise<void> {
    this.ready ??= (async () => {
      const raw = await this.kv.read(KEY);
      const state = raw ? deserialise(raw) : null;
      if (state) this.inner.load(state);
    })();
    return this.ready;
  }

  async transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    await this.load();
    return this.inner.transaction(fn);
  }
}
