import type { ChangeItem } from "../api/client";
import type { QueuedOperation } from "./offlineQueue";
import { MemoryStore } from "./queueStorage";
import { CACHE_STORE_VERSION, LocalCache } from "./localCache";

function change(overrides: Partial<ChangeItem> = {}): ChangeItem {
  return {
    entity_type: "task",
    entity_id: "task-1",
    operation: "upsert",
    cursor: 4,
    changed_at: "2026-10-27T09:00:00+00:00",
    ...overrides,
  };
}

function operation(overrides: Partial<QueuedOperation> = {}): QueuedOperation {
  return {
    id: "op-1",
    seq: 1,
    entityType: "task",
    entityId: "task-1",
    mutation: "update",
    idempotencyKey: "idem-1",
    baseRevision: 3,
    payload: {},
    createdAt: "2026-10-27T09:00:00.000Z",
    attempts: 0,
    status: "pending",
    lastError: null,
    serverRevision: null,
    ...overrides,
  };
}

describe("LocalCache.applyChanges", () => {
  it("records an upsert and a delete tombstone", async () => {
    const cache = new LocalCache(new MemoryStore());
    await cache.applyChanges([
      change({ entity_id: "task-1", operation: "upsert", cursor: 4 }),
      change({ entity_id: "task-2", operation: "delete", cursor: 8 }),
    ]);

    const listed = await cache.list();
    expect(listed).toHaveLength(2);
    expect(await cache.get("task", "task-1")).toMatchObject({ cursor: 4, deleted: false });
    expect(await cache.get("task", "task-2")).toMatchObject({ cursor: 8, deleted: true });
  });

  it("is idempotent: re-applying a page (or an older one) changes nothing", async () => {
    const cache = new LocalCache(new MemoryStore());
    await cache.applyChanges([change({ cursor: 8 })]);
    await cache.applyChanges([change({ cursor: 8 })]); // exact re-delivery
    await cache.applyChanges([change({ cursor: 3 })]); // an older/duplicate page

    const listed = await cache.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].cursor).toBe(8);
  });

  it("keeps a tombstone for a deleted entity (never resurrects it)", async () => {
    const cache = new LocalCache(new MemoryStore());
    await cache.applyChanges([change({ operation: "delete", cursor: 8 })]);
    expect((await cache.get("task", "task-1"))?.deleted).toBe(true);
  });

  it("preserves the queue-owned flags across a later server change", async () => {
    const cache = new LocalCache(new MemoryStore());
    await cache.markLocalState([operation({ status: "conflict", serverRevision: 9 })]);
    // A newer server change arrives for the same entity: the conflict must survive.
    await cache.applyChanges([change({ cursor: 12 })]);

    const entry = await cache.get("task", "task-1");
    expect(entry).toMatchObject({ cursor: 12, conflict: true, serverRevision: 9, localPending: true });
  });
});

describe("LocalCache.markLocalState", () => {
  it("marks a queued edit and re-derives the flags idempotently", async () => {
    const cache = new LocalCache(new MemoryStore());
    await cache.markLocalState([
      operation({ entityId: "a", status: "pending" }),
      operation({ entityId: "b", status: "conflict", serverRevision: 7 }),
      operation({ entityId: "c", status: "failed" }),
    ]);

    const first = await cache.snapshot();
    expect(first.pending).toBe(2); // a (pending) + b (kept conflict)
    expect(first.conflicts).toBe(1);

    // Re-running with the queue drained must clear the flags, not accumulate them.
    await cache.markLocalState([]);
    const cleared = await cache.snapshot();
    expect(cleared.pending).toBe(0);
    expect(cleared.conflicts).toBe(0);
  });

  it("records the server revision on a kept conflict", async () => {
    const cache = new LocalCache(new MemoryStore());
    await cache.markLocalState([operation({ status: "conflict", serverRevision: 11 })]);
    const [conflict] = await cache.conflicts();
    expect(conflict).toMatchObject({ entityId: "task-1", conflict: true, serverRevision: 11 });
  });
});

describe("LocalCache durability and format", () => {
  it("survives re-instantiation from the same backing storage", async () => {
    const storage = new MemoryStore();
    await new LocalCache(storage).applyChanges([change({ cursor: 5 })]);

    // A brand-new cache over the same storage — nothing was kept in memory.
    const reloaded = await new LocalCache(storage).get("task", "task-1");
    expect(reloaded).toMatchObject({ cursor: 5 });
  });

  it("discards a stored cache written by an unknown format version", async () => {
    const storage = new MemoryStore();
    await storage.write(
      "cache",
      JSON.stringify({ version: CACHE_STORE_VERSION + 99, entries: [change()] }),
    );
    expect(await new LocalCache(storage).list()).toEqual([]);
  });

  it("starts clean when the stored blob is corrupt rather than crashing", async () => {
    const storage = new MemoryStore();
    await storage.write("cache", "{ not json");
    expect((await new LocalCache(storage).snapshot()).total).toBe(0);
  });

  it("clears every entry for a full resync", async () => {
    const cache = new LocalCache(new MemoryStore());
    await cache.applyChanges([change()]);
    await cache.clear();
    expect(await cache.list()).toEqual([]);
  });
});
