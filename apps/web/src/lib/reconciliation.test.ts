import { ApiError, type ChangeFeed, type ChangeItem } from "../api/client";
import { LocalCache } from "./localCache";
import { OfflineQueue, type QueuedOperation } from "./offlineQueue";
import { MemoryStore } from "./queueStorage";
import { SyncCursorStore } from "./syncEngine";
import { Reconciler, reconcile } from "./reconciliation";

/** One change-feed item with sensible defaults. */
function changeItem(entityId: string, cursor: number, operation = "upsert"): ChangeItem {
  return {
    entity_type: "task",
    entity_id: entityId,
    operation,
    cursor,
    changed_at: "2026-10-27T09:00:00+00:00",
  };
}

/** One feed page with sensible defaults. */
function feed(overrides: Partial<ChangeFeed> = {}): ChangeFeed {
  return {
    changes: [],
    since: 0,
    next_since: 0,
    has_more: false,
    resync_required: false,
    head: 0,
    floor: 0,
    ...overrides,
  };
}

/** A queue, cursor and cache over one shared durable backing (a `MemoryStore` models the browser). */
function harness(store: MemoryStore = new MemoryStore()): {
  store: MemoryStore;
  queue: OfflineQueue;
  cursor: SyncCursorStore;
  cache: LocalCache;
} {
  return {
    store,
    queue: new OfflineQueue(store),
    cursor: new SyncCursorStore(store),
    cache: new LocalCache(store),
  };
}

/** A `listChanges` that pages an empty feed forever (the cursor does not move). */
function emptyFeed(since: number): Promise<ChangeFeed> {
  return Promise.resolve(feed({ since, next_since: since }));
}

describe("reconcile — ordering", () => {
  it("replays the durable queue (flush) before pulling the change feed", async () => {
    const { queue, cursor, cache } = harness();
    await queue.enqueue({
      entityType: "task",
      entityId: "task-1",
      mutation: "update",
      baseRevision: 1,
    });

    const order: string[] = [];
    const result = await reconcile({
      queue,
      cursor,
      cache,
      send: async () => {
        order.push("flush");
      },
      listChanges: async () => {
        order.push("pull");
        return feed({ since: 0, next_since: 7 });
      },
    });

    expect(order).toEqual(["flush", "pull"]);
    expect(result.flush.sent).toBe(1);
    expect(result.pull.nextSince).toBe(7);
    expect(await cursor.get()).toBe(7);
  });
});

describe("reconcile — conflicts", () => {
  it("surfaces a stale 409, keeps the local change and never clobbers the server", async () => {
    const { queue, cursor, cache } = harness();
    await queue.enqueue({
      entityType: "task",
      entityId: "task-1",
      mutation: "update",
      baseRevision: 3,
    });
    const listChanges = vi.fn(async (since: number) => feed({ since, next_since: 5 }));

    const result = await reconcile({
      queue,
      cursor,
      cache,
      send: async () => {
        throw new ApiError(409, "stale revision", { detail: { current_revision: 9 } });
      },
      listChanges,
    });

    // Surfaced for the UI, with the server's revision recorded.
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      entityType: "task",
      entityId: "task-1",
      conflict: true,
      serverRevision: 9,
    });

    // The local change is retained in the queue (never dropped)…
    const queued = await queue.list();
    expect(queued).toHaveLength(1);
    expect(queued[0].status).toBe("conflict");
    // …and the cache still shows it as a kept local edit.
    expect(await cache.get("task", "task-1")).toMatchObject({
      conflict: true,
      localPending: true,
      serverRevision: 9,
    });

    // The pass still pulls (the client stays eventually consistent for everything else).
    expect(listChanges).toHaveBeenCalledTimes(1);
  });

  it("applies a server change to the cache while keeping a queued local edit", async () => {
    const { queue, cursor, cache } = harness();
    await queue.enqueue({
      entityType: "task",
      entityId: "task-1",
      mutation: "update",
      baseRevision: 3,
    });

    const result = await reconcile({
      queue,
      cursor,
      cache,
      // The replay never lands (network), but the feed reports a change for the same entity.
      send: async () => {
        throw new TypeError("Failed to fetch");
      },
      listChanges: async (since) =>
        feed({ since, next_since: 9, changes: [changeItem("task-1", 9)] }),
    });

    // The server's state is applied, but the local edit is neither dropped nor a conflict yet.
    expect(await cache.get("task", "task-1")).toMatchObject({ cursor: 9, localPending: true });
    expect((await queue.snapshot()).total).toBe(1);
    expect(result.conflicts).toHaveLength(0);
  });
});

describe("reconcile — idempotence and retry", () => {
  it("is idempotent: a second pass sends and applies nothing new", async () => {
    const { queue, cursor, cache } = harness();
    await queue.enqueue({
      entityType: "task",
      entityId: "task-1",
      mutation: "update",
      baseRevision: 1,
    });
    const send = vi.fn(async () => {});
    const listChanges = vi.fn(async (since: number) =>
      since === 0
        ? feed({ since: 0, next_since: 5, changes: [changeItem("task-1", 5)] })
        : feed({ since, next_since: since }),
    );

    const first = await reconcile({ queue, cursor, cache, send, listChanges });
    const afterFirst = await cache.snapshot();

    const second = await reconcile({ queue, cursor, cache, send, listChanges });
    const afterSecond = await cache.snapshot();

    expect(first.flush.sent).toBe(1);
    expect(second.flush.sent).toBe(0); // the op was already replayed
    expect(send).toHaveBeenCalledTimes(1); // no duplicate effect
    expect(await queue.snapshot()).toMatchObject({ total: 0 });
    expect(second.pull.changes).toEqual([]); // the cursor advanced; nothing new delivered
    expect(afterSecond.entries).toEqual(afterFirst.entries); // the cache is unchanged
    expect(await cursor.get()).toBe(5);
  });

  it("retries a network failure on the next pass without duplicating the change", async () => {
    const { queue, cursor, cache } = harness();
    await queue.enqueue({
      entityType: "task",
      entityId: "task-1",
      mutation: "update",
      baseRevision: 1,
    });
    const keys: string[] = [];
    let attempt = 0;
    const send = async (operation: QueuedOperation) => {
      keys.push(operation.idempotencyKey);
      attempt += 1;
      if (attempt === 1) {
        throw new TypeError("Failed to fetch");
      }
    };

    const first = await reconcile({ queue, cursor, cache, send, listChanges: emptyFeed });
    expect(first.flush.sent).toBe(0);
    expect((await queue.snapshot()).total).toBe(1);
    expect(await cache.get("task", "task-1")).toMatchObject({ localPending: true });

    const second = await reconcile({ queue, cursor, cache, send, listChanges: emptyFeed });
    expect(second.flush.sent).toBe(1);
    expect((await queue.snapshot()).total).toBe(0);
    expect(await cache.get("task", "task-1")).toMatchObject({ localPending: false });

    // The same idempotency key was sent twice, so the server treats it as one request.
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });
});

describe("reconcile — resync_required", () => {
  it("drops the cache and resumes from the head, keeping the queued local edit", async () => {
    const { queue, cursor, cache } = harness();
    await cursor.set(3);
    await cache.applyChanges([changeItem("stale", 2)]); // a possibly-stale cache entry
    await queue.enqueue({
      entityType: "project",
      entityId: "project-1",
      mutation: "update",
      baseRevision: 1,
    });
    const fullResync = vi.fn(async () => {});

    const result = await reconcile({
      queue,
      cursor,
      cache,
      send: async () => {
        throw new TypeError("Failed to fetch"); // the queued edit stays pending
      },
      listChanges: async () => feed({ since: 3, next_since: 120, resync_required: true }),
      fullResync,
    });

    expect(result.pull.resyncRequired).toBe(true);
    expect(fullResync).toHaveBeenCalledTimes(1);
    expect(await cursor.get()).toBe(120); // resumes from the server's head, not the empty page
    expect(await cache.get("task", "stale")).toBeNull(); // stale cache dropped
    expect(await cache.get("project", "project-1")).toMatchObject({ localPending: true }); // kept
  });
});

describe("reconcile — durability across reload", () => {
  it("keeps the queue, cursor and cache across a reload and still converges", async () => {
    const store = new MemoryStore();
    {
      const { queue, cursor, cache } = harness(store);
      await queue.enqueue({
        entityType: "task",
        entityId: "task-1",
        mutation: "update",
        baseRevision: 2,
      });
      await reconcile({
        queue,
        cursor,
        cache,
        send: async () => {
          throw new TypeError("Failed to fetch");
        },
        listChanges: async (since) =>
          feed({ since, next_since: 6, changes: [changeItem("task-9", 6)] }),
      });
    }

    // A fresh set of stores over the same durable backing models a page reload.
    const { queue, cursor, cache } = harness(store);
    expect((await queue.list()).map((op) => op.entityId)).toEqual(["task-1"]);
    expect(await cursor.get()).toBe(6);
    expect((await cache.get("task", "task-1"))?.localPending).toBe(true);
    expect((await cache.get("task", "task-9"))?.cursor).toBe(6);

    // The reloaded client reconciles to completion: the pending edit lands and clears.
    const result = await reconcile({
      queue,
      cursor,
      cache,
      send: async () => {},
      listChanges: emptyFeed,
    });
    expect(result.flush.sent).toBe(1);
    expect((await cache.get("task", "task-1"))?.localPending).toBe(false);
  });
});

describe("Reconciler", () => {
  it("runs a pass and exposes the surfaced conflicts", async () => {
    const { queue, cursor, cache } = harness();
    await queue.enqueue({
      entityType: "task",
      entityId: "task-1",
      mutation: "update",
      baseRevision: 1,
    });
    const reconciler = new Reconciler({
      queue,
      cursor,
      cache,
      send: async () => {
        throw new ApiError(409, "stale revision", { detail: { current_revision: 4 } });
      },
      listChanges: emptyFeed,
    });

    const result = await reconciler.run();
    expect(result.conflicts).toHaveLength(1);
    expect(await reconciler.conflicts()).toHaveLength(1);
  });
});
