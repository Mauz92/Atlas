import { ApiError, type ChangeFeed } from "../api/client";
import { MemoryStore } from "./queueStorage";
import { OfflineQueue, type QueuedOperation } from "./offlineQueue";
import {
  SyncCursorStore,
  SyncEngine,
  flushQueue,
  pullChanges,
  sendOperation,
} from "./syncEngine";

/** Build a queue with the given operations already enqueued, in order. */
async function queueWith(...ids: string[]): Promise<OfflineQueue> {
  const queue = new OfflineQueue(new MemoryStore());
  for (const id of ids) {
    await queue.enqueue({ entityType: "task", entityId: id, mutation: "update", baseRevision: 1 });
  }
  return queue;
}

function feed(overrides: Partial<ChangeFeed> = {}): ChangeFeed {
  return {
    changes: [],
    since: 0,
    next_since: 0,
    has_more: false,
    resync_required: false,
    ...overrides,
  };
}

describe("flushQueue", () => {
  it("replays queued operations in FIFO order and removes those that succeed", async () => {
    const queue = await queueWith("a", "b", "c");
    const order: string[] = [];
    const send = async (operation: QueuedOperation) => {
      order.push(operation.entityId);
    };

    const result = await flushQueue(queue, send);

    expect(order).toEqual(["a", "b", "c"]);
    expect(result.sent).toBe(3);
    expect(result.conflict).toBeNull();
    expect((await queue.snapshot()).total).toBe(0);
  });

  it("surfaces a stale 409 and keeps the operation (never clobbers)", async () => {
    const queue = await queueWith("a", "b");
    const send = async (operation: QueuedOperation) => {
      if (operation.entityId === "a") {
        throw new ApiError(409, "stale revision", { detail: { current_revision: 9 } });
      }
    };

    const result = await flushQueue(queue, send);

    expect(result.conflict).not.toBeNull();
    expect(result.conflict?.serverRevision).toBe(9);
    expect(result.stopped).toBe(true);

    const listed = await queue.list();
    // The conflicted op is kept; the later op was not sent (order preserved). Nothing was removed.
    expect(listed.map((op) => op.entityId)).toEqual(["a", "b"]);
    expect(listed[0].status).toBe("conflict");
    expect(listed[1].status).toBe("pending");
  });

  it("keeps the queue for the next reconnect on a retryable (network) failure", async () => {
    const queue = await queueWith("a");
    const send = async () => {
      throw new TypeError("Failed to fetch");
    };

    const result = await flushQueue(queue, send);

    expect(result.stopped).toBe(true);
    const [listed] = await queue.list();
    expect(listed.status).toBe("pending");
    expect(listed.attempts).toBe(1);
  });

  it("marks a permanent 4xx as failed and continues with the next operation", async () => {
    const queue = await queueWith("a", "b");
    const send = async (operation: QueuedOperation) => {
      if (operation.entityId === "a") {
        throw new ApiError(422, "invalid payload");
      }
    };

    const result = await flushQueue(queue, send);

    expect(result.failed).toBe(1);
    expect(result.sent).toBe(1);
    const listed = await queue.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ entityId: "a", status: "failed" });
  });

  it("does not duplicate an operation on retry (the idempotency key is stable)", async () => {
    const queue = await queueWith("a");
    const keys: string[] = [];
    let attempt = 0;
    const send = async (operation: QueuedOperation) => {
      keys.push(operation.idempotencyKey);
      attempt += 1;
      if (attempt === 1) {
        throw new TypeError("Failed to fetch");
      }
    };

    await flushQueue(queue, send); // network loss
    expect((await queue.snapshot()).total).toBe(1);

    const second = await flushQueue(queue, send); // reconnect
    expect(second.sent).toBe(1);
    expect((await queue.snapshot()).total).toBe(0);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });
});

describe("sendOperation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function op(overrides: Partial<QueuedOperation>): QueuedOperation {
    return {
      id: "op-1",
      seq: 1,
      entityType: "task",
      entityId: "task-1",
      mutation: "update",
      idempotencyKey: "idem-1",
      baseRevision: 3,
      payload: { title: "Offline" },
      createdAt: "2026-10-27T09:00:00.000Z",
      attempts: 0,
      status: "pending",
      lastError: null,
      serverRevision: null,
      ...overrides,
    };
  }

  it("sends an update as PATCH with the idempotency key and base_revision", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await sendOperation(op({}));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/tasks/task-1");
    expect(init.method).toBe("PATCH");
    expect((init.headers as Headers).get("Idempotency-Key")).toBe("idem-1");
    expect(JSON.parse(init.body as string)).toEqual({ title: "Offline", base_revision: 3 });
  });

  it("sends a create as POST to the collection", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await sendOperation(
      op({ mutation: "create", entityType: "project", entityId: "tmp", baseRevision: null }),
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/projects");
    expect(init.method).toBe("POST");
    expect((init.headers as Headers).get("Idempotency-Key")).toBe("idem-1");
  });

  it("sends a delete as DELETE", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await sendOperation(op({ mutation: "delete" }));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/tasks/task-1");
    expect(init.method).toBe("DELETE");
  });
});

describe("pullChanges", () => {
  it("pages from the stored cursor and advances it only after each page is applied", async () => {
    const cursor = new SyncCursorStore(new MemoryStore());
    const seenAtApply: number[] = [];
    const pages: ChangeFeed[] = [
      feed({
        since: 0,
        next_since: 5,
        has_more: true,
        changes: [
          { entity_type: "task", entity_id: "a", operation: "upsert", cursor: 4, changed_at: "" },
        ],
      }),
      feed({
        since: 5,
        next_since: 9,
        has_more: false,
        changes: [
          { entity_type: "task", entity_id: "b", operation: "delete", cursor: 8, changed_at: "" },
        ],
      }),
    ];
    const listChanges = vi.fn(async (since: number) => pages[since === 0 ? 0 : 1]);

    const result = await pullChanges({
      cursor,
      listChanges,
      onChanges: async () => {
        seenAtApply.push(await cursor.get());
      },
    });

    expect(listChanges).toHaveBeenNthCalledWith(1, 0);
    expect(listChanges).toHaveBeenNthCalledWith(2, 5);
    expect(result.changes.map((c) => c.entity_id)).toEqual(["a", "b"]);
    expect(result.pages).toBe(2);
    expect(result.resyncRequired).toBe(false);
    // The cursor was still on the previous page while those changes were applied.
    expect(seenAtApply).toEqual([0, 5]);
    expect(await cursor.get()).toBe(9);
  });

  it("triggers a full resync when the cursor predates the retention floor", async () => {
    const cursor = new SyncCursorStore(new MemoryStore());
    await cursor.set(3);
    const fullResync = vi.fn(async () => {});
    const listChanges = vi.fn(async () =>
      feed({ since: 3, next_since: 120, has_more: false, resync_required: true }),
    );

    const result = await pullChanges({ cursor, listChanges, fullResync });

    expect(fullResync).toHaveBeenCalledTimes(1);
    expect(result.resyncRequired).toBe(true);
    expect(result.changes).toEqual([]);
    expect(result.nextSince).toBe(120);
    expect(await cursor.get()).toBe(120);
  });

  it("does not advance the cursor when applying a page fails", async () => {
    const cursor = new SyncCursorStore(new MemoryStore());
    const listChanges = async () => feed({ since: 0, next_since: 5, has_more: true, changes: [] });

    await expect(
      pullChanges({
        cursor,
        listChanges,
        onChanges: () => {
          throw new Error("apply failed");
        },
      }),
    ).rejects.toThrow("apply failed");

    expect(await cursor.get()).toBe(0);
  });
});

describe("SyncEngine", () => {
  it("replays the queue and then pulls the change feed", async () => {
    const queue = await queueWith("a");
    const cursor = new SyncCursorStore(new MemoryStore());
    const order: string[] = [];
    const engine = new SyncEngine({
      queue,
      cursor,
      send: async () => {
        order.push("flush");
      },
      listChanges: async () => {
        order.push("pull");
        return feed({ next_since: 7 });
      },
    });

    const { flush, pull } = await engine.sync();

    expect(order).toEqual(["flush", "pull"]);
    expect(flush.sent).toBe(1);
    expect(pull.nextSince).toBe(7);
    expect(await cursor.get()).toBe(7);
  });
});
