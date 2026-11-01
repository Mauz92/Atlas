/**
 * Durable key/value backing for the offline queue (M7-03).
 *
 * AGENTS.md §7.4 keeps the *business* logic on the server, but an offline queue has to survive a
 * page reload, so it lives in browser storage. The store prefers **IndexedDB** (via a thin wrapper
 * over the native API — no third-party sync framework), and falls back to `localStorage` when
 * IndexedDB is unavailable, and finally to an in-memory store when neither exists (e.g. a locked-down
 * or private-mode browser). The chosen backing is documented in ADR-0034.
 *
 * This module is deliberately a *dumb* key/value layer: it stores opaque strings and knows nothing
 * about operations, ordering or versions (that is `offlineQueue.ts`). That keeps the IndexedDB code
 * small and the queue logic testable against any store.
 */

/** The persistent backings the queue can use, in order of preference. */
export type StorageKind = "indexeddb" | "localstorage" | "memory";

/** An asynchronous string key/value store — the queue's durable backing. */
export interface KeyValueStore {
  readonly kind: StorageKind;
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/* -------------------------------------------------------------------------------------------------
 * IndexedDB (preferred)
 * ----------------------------------------------------------------------------------------------- */

const DB_NAME = "atlas-offline";
const DB_VERSION = 1;
const OBJECT_STORE = "kv";

/**
 * A minimal IndexedDB-backed store: one object store holding string values keyed by name.
 *
 * If IndexedDB is present but broken (for example a browser that exposes the API yet rejects the
 * open — private mode in some engines), every method degrades to an in-memory store for the rest of
 * the session and warns once. The queue then keeps working (just without durability), rather than
 * throwing on every edit; the fallback is documented in ADR-0034.
 */
export class IndexedDbStore implements KeyValueStore {
  readonly kind: StorageKind = "indexeddb";
  private db: Promise<IDBDatabase> | null = null;
  private readonly fallback = new MemoryStore();
  private degraded = false;

  constructor(private readonly dbName: string = DB_NAME) {}

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(this.dbName, DB_VERSION);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(OBJECT_STORE)) {
            database.createObjectStore(OBJECT_STORE);
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
        request.onblocked = () => reject(new Error("IndexedDB open blocked"));
      });
    }
    return this.db;
  }

  /** Run a transaction, degrading to memory if IndexedDB cannot be used at all. */
  private async guard<T>(work: (db: IDBDatabase) => Promise<T>, mem: () => Promise<T>): Promise<T> {
    if (this.degraded) {
      return mem();
    }
    try {
      return await work(await this.open());
    } catch (error) {
      this.degraded = true;
      this.db = null;
      // A broken IndexedDB is an environment problem, not a data-integrity one: surface it once and
      // keep the app usable. Never silently lose the *server* copy — the queue is only a client cache.
      console.warn("IndexedDB unavailable; falling back to an in-memory offline queue", error);
      return mem();
    }
  }

  async read(key: string): Promise<string | null> {
    return this.guard(
      (db) =>
        new Promise<string | null>((resolve, reject) => {
          const request = db.transaction(OBJECT_STORE, "readonly").objectStore(OBJECT_STORE).get(key);
          request.onsuccess = () => resolve((request.result as string | undefined) ?? null);
          request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
        }),
      () => this.fallback.read(key),
    );
  }

  async write(key: string, value: string): Promise<void> {
    return this.guard(
      (db) =>
        new Promise<void>((resolve, reject) => {
          const tx = db.transaction(OBJECT_STORE, "readwrite");
          tx.objectStore(OBJECT_STORE).put(value, key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
          tx.onabort = () => reject(tx.error ?? new Error("IndexedDB write aborted"));
        }),
      () => this.fallback.write(key, value),
    );
  }

  async remove(key: string): Promise<void> {
    return this.guard(
      (db) =>
        new Promise<void>((resolve, reject) => {
          const tx = db.transaction(OBJECT_STORE, "readwrite");
          tx.objectStore(OBJECT_STORE).delete(key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error("IndexedDB delete failed"));
        }),
      () => this.fallback.remove(key),
    );
  }
}

/* -------------------------------------------------------------------------------------------------
 * localStorage (fallback)
 * ----------------------------------------------------------------------------------------------- */

const LS_PREFIX = "atlas.offline.";

/** A `localStorage`-backed store. Used when IndexedDB is not available. */
export class LocalStorageStore implements KeyValueStore {
  readonly kind: StorageKind = "localstorage";

  constructor(private readonly prefix: string = LS_PREFIX) {}

  async read(key: string): Promise<string | null> {
    try {
      return globalThis.localStorage.getItem(this.prefix + key);
    } catch {
      return null;
    }
  }

  async write(key: string, value: string): Promise<void> {
    // A quota/storage error must surface: silently dropping a queued edit would lose it.
    globalThis.localStorage.setItem(this.prefix + key, value);
  }

  async remove(key: string): Promise<void> {
    try {
      globalThis.localStorage.removeItem(this.prefix + key);
    } catch {
      // Nothing to remove / storage unavailable — the absence is the desired state.
    }
  }
}

/* -------------------------------------------------------------------------------------------------
 * In-memory (last resort / tests)
 * ----------------------------------------------------------------------------------------------- */

/** A non-durable store. The last-resort fallback and a convenient test double. */
export class MemoryStore implements KeyValueStore {
  readonly kind: StorageKind = "memory";
  private readonly values = new Map<string, string>();

  async read(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async write(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

/**
 * Choose the best available backing: IndexedDB, then `localStorage`, then memory.
 *
 * The queue is always constructed over the result so a single, durable instance is shared across the
 * app (a reload constructs a fresh instance over the same backing storage).
 */
export function createKeyValueStore(): KeyValueStore {
  if (typeof indexedDB !== "undefined") {
    return new IndexedDbStore();
  }
  if (typeof localStorage !== "undefined") {
    return new LocalStorageStore();
  }
  return new MemoryStore();
}

let sharedStore: KeyValueStore | null = null;

/**
 * The app-wide durable backing, shared by the queue and the sync cursor so both persist in one place
 * (and both survive a reload). Tests construct their own {@link createKeyValueStore} instead.
 */
export function getSharedDurableStore(): KeyValueStore {
  if (!sharedStore) {
    sharedStore = createKeyValueStore();
  }
  return sharedStore;
}
