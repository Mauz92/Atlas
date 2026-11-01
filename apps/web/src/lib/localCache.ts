/**
 * Durable local cache of the entities the client has learned about from the change feed (M7-04).
 *
 * On reconnect the sync engine replays the offline queue (M7-03) and then pulls `GET /api/changes`
 * from its stored cursor. Each change it pulls is applied here, so the client keeps a local, durable
 * mirror of *what the server says changed* and can converge without re-fetching everything.
 *
 * The cache is deliberately **metadata, not payload**: the M7-01 feed carries no entity body (only
 * `entity_type`, `entity_id`, `operation`, `cursor`, `changed_at`), so an entry records the latest
 * change per entity — whether it is a live `upsert` or a `delete` tombstone — plus the client-only
 * flags the sync surface needs. A consumer that wants the body fetches it from the ordinary endpoint.
 *
 * Two rules make it safe (AGENTS.md §9, `ARCHITECTURE.md` §5/§7):
 *
 * - **The server is authoritative.** Applying a feed page never depends on local edits; the local
 *   edit itself lives in the durable queue and is replayed by the engine, so a pull can never drop
 *   the user's offline work. `delete` tombstones are kept so a deleted entity cannot be resurrected.
 * - **The cache is a cache.** It persists through the same durable {@link KeyValueStore} as the queue
 *   and cursor (so it survives a reload), but a lost/unreadable cache is recoverable by a full pull.
 *
 * The **queue-owned** flags (`localPending`, `conflict`, `serverRevision`) are never set from the feed
 * — they are derived from the queue by {@link LocalCache.markLocalState}, which keeps the "keep-local +
 * surface" conflict policy (ADR-0035) consistent across a reload and idempotent to re-run.
 */

import type { ChangeItem } from "../api/client";
import { getSharedDurableStore, type KeyValueStore } from "./queueStorage";
import type { QueuedOperation } from "./offlineQueue";

/** One entity the client has observed change, plus the client's own sync state for it. */
export interface CacheEntry {
  /** The feed's entity type (`task` | `project` | `note` | …). */
  entityType: string;
  /** The entity's id within its type. */
  entityId: string;
  /** The cursor of the latest server change seen for this entity (only ever moves forward). */
  cursor: number;
  /** True when the latest server change was a `delete` tombstone. */
  deleted: boolean;
  /** When the server last changed the entity (ISO 8601, from the feed). */
  changedAt: string;
  /** A local edit to this entity is queued and not yet applied on the server. */
  localPending: boolean;
  /** A stale-write conflict is outstanding: the local edit is kept, the server not clobbered. */
  conflict: boolean;
  /** The revision the server held when the conflict was detected (`null` when unknown). */
  serverRevision: number | null;
  /** When this entry was last written (client clock, ISO 8601). */
  updatedAt: string;
}

/** A read-only view of the cache for the status surface (M7-05 builds on this). */
export interface CacheSnapshot {
  entries: CacheEntry[];
  total: number;
  pending: number;
  conflicts: number;
}

/** The persisted shape. `version` lets a future change migrate instead of guessing. */
interface StoredCache {
  version: number;
  entries: CacheEntry[];
}

/**
 * The stored-format version. Bump it when the on-disk shape changes **and** add a migration; an
 * unrecognised version is discarded (never mis-read), which is safe because the server is
 * authoritative and a full pull restores the cache.
 */
export const CACHE_STORE_VERSION = 1;

const CACHE_KEY = "cache";

function keyOf(entityType: string, entityId: string): string {
  return `${entityType}:${entityId}`;
}

function isStoredCache(value: unknown): value is StoredCache {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<StoredCache>;
  return (
    Array.isArray(candidate.entries) &&
    candidate.entries.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        typeof (entry as CacheEntry).entityType === "string" &&
        typeof (entry as CacheEntry).entityId === "string",
    )
  );
}

/**
 * The durable local cache.
 *
 * Construct one per app (or per test) over a {@link KeyValueStore}; two instances over the *same*
 * backing store see the same entries, which is how a page reload is modelled.
 */
export class LocalCache {
  constructor(
    private readonly storage: KeyValueStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async load(): Promise<Map<string, CacheEntry>> {
    const raw = await this.storage.read(CACHE_KEY);
    const entries = new Map<string, CacheEntry>();
    if (!raw) {
      return entries;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A corrupt blob cannot be recovered; start clean. A full pull restores the cache.
      return entries;
    }
    if (!isStoredCache(parsed) || parsed.version !== CACHE_STORE_VERSION) {
      return entries;
    }
    for (const entry of parsed.entries) {
      entries.set(keyOf(entry.entityType, entry.entityId), entry);
    }
    return entries;
  }

  private async save(entries: Map<string, CacheEntry>): Promise<void> {
    const stored: StoredCache = { version: CACHE_STORE_VERSION, entries: [...entries.values()] };
    await this.storage.write(CACHE_KEY, JSON.stringify(stored));
  }

  /**
   * Apply one page of the change feed.
   *
   * Re-applying the same page (or an older one) is a **no-op**: a change whose cursor is not newer
   * than the entry's is ignored, so a re-delivered page cannot duplicate or regress an entry. Local
   * flags are owned by {@link markLocalState}, not the feed, and are preserved across an update.
   */
  async applyChanges(changes: ChangeItem[]): Promise<void> {
    const entries = await this.load();
    const now = this.clock().toISOString();
    for (const change of changes) {
      const key = keyOf(change.entity_type, change.entity_id);
      const existing = entries.get(key);
      if (existing && change.cursor <= existing.cursor) {
        continue;
      }
      entries.set(key, {
        entityType: change.entity_type,
        entityId: change.entity_id,
        cursor: change.cursor,
        deleted: change.operation === "delete",
        changedAt: change.changed_at,
        // Queue-owned flags: never taken from the feed.
        localPending: existing?.localPending ?? false,
        conflict: existing?.conflict ?? false,
        serverRevision: existing?.serverRevision ?? null,
        updatedAt: now,
      });
    }
    await this.save(entries);
  }

  /**
   * Re-derive the queue-owned flags from the current queue.
   *
   * This is the single source of truth for `localPending`/`conflict`, so it is **idempotent**: the
   * flags are reset and re-computed from the operations every call, and an entity with a queued edit
   * is never reported as fully synced. A `pending` operation marks the entity as having a local edit
   * in flight; a `conflict` operation marks it as conflicted and records the server revision (the
   * local edit is kept — never clobbered, never silently dropped).
   */
  async markLocalState(operations: QueuedOperation[]): Promise<void> {
    const entries = await this.load();
    const now = this.clock().toISOString();
    for (const entry of entries.values()) {
      entry.localPending = false;
      entry.conflict = false;
      entry.serverRevision = null;
    }
    for (const operation of operations) {
      const key = keyOf(operation.entityType, operation.entityId);
      const entry = entries.get(key) ?? {
        entityType: operation.entityType,
        entityId: operation.entityId,
        cursor: 0,
        deleted: false,
        changedAt: operation.createdAt,
        localPending: false,
        conflict: false,
        serverRevision: null,
        updatedAt: now,
      };
      if (operation.status === "pending") {
        entry.localPending = true;
      }
      if (operation.status === "conflict") {
        entry.localPending = true;
        entry.conflict = true;
        entry.serverRevision = operation.serverRevision;
      }
      entry.updatedAt = now;
      entries.set(key, entry);
    }
    await this.save(entries);
  }

  /** One entry, or `null` when the cache has not seen the entity. */
  async get(entityType: string, entityId: string): Promise<CacheEntry | null> {
    const entries = await this.load();
    return entries.get(keyOf(entityType, entityId)) ?? null;
  }

  /** Every entry, ordered by type then id for stable rendering. */
  async list(): Promise<CacheEntry[]> {
    const entries = await this.load();
    return [...entries.values()].sort(
      (a, b) =>
        a.entityType.localeCompare(b.entityType) || a.entityId.localeCompare(b.entityId),
    );
  }

  /** The entities with an outstanding conflict (the ones the UI must surface). */
  async conflicts(): Promise<CacheEntry[]> {
    return (await this.list()).filter((entry) => entry.conflict);
  }

  /** A summary for the status surface. */
  async snapshot(): Promise<CacheSnapshot> {
    const entries = await this.list();
    return {
      entries,
      total: entries.length,
      pending: entries.filter((entry) => entry.localPending).length,
      conflicts: entries.filter((entry) => entry.conflict).length,
    };
  }

  /** Empty the cache (used when the server requires a full resync because our cursor fell behind). */
  async clear(): Promise<void> {
    await this.save(new Map());
  }
}

let sharedCache: LocalCache | null = null;

/** The app-wide cache, over the same durable backing as the queue and cursor so it survives a reload. */
export function getLocalCache(): LocalCache {
  if (!sharedCache) {
    sharedCache = new LocalCache(getSharedDurableStore());
  }
  return sharedCache;
}
