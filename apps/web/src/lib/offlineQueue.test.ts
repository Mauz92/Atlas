import { LocalStorageStore, MemoryStore } from "./queueStorage";
import { OfflineQueue, QUEUE_STORE_VERSION, newIdempotencyKey } from "./offlineQueue";

function fixedClock(): () => Date {
  return () => new Date("2026-10-27T09:00:00.000Z");
}

describe("OfflineQueue.enqueue", () => {
  it("records the entity, mutation, idempotency key and base_revision", async () => {
    const queue = new OfflineQueue(new MemoryStore(), fixedClock());
    const operation = await queue.enqueue({
      entityType: "task",
      entityId: "task-1",
      mutation: "update",
      baseRevision: 4,
      payload: { title: "Offline edit" },
    });

    expect(operation.entityType).toBe("task");
    expect(operation.entityId).toBe("task-1");
    expect(operation.mutation).toBe("update");
    expect(operation.baseRevision).toBe(4);
    expect(operation.idempotencyKey).toBeTruthy();
    expect(operation.createdAt).toBe("2026-10-27T09:00:00.000Z");
    expect(operation.status).toBe("pending");
  });

  it("keeps the supplied idempotency key so a replay stays idempotent", async () => {
    const queue = new OfflineQueue(new MemoryStore());
    const operation = await queue.enqueue({
      entityType: "task",
      entityId: "task-1",
      mutation: "create",
      idempotencyKey: "stable-key",
    });
    expect(operation.idempotencyKey).toBe("stable-key");
    expect(operation.baseRevision).toBeNull();
  });

  it("assigns FIFO order via seq", async () => {
    const queue = new OfflineQueue(new MemoryStore());
    await queue.enqueue({ entityType: "task", entityId: "a", mutation: "create" });
    await queue.enqueue({ entityType: "task", entityId: "b", mutation: "update" });
    await queue.enqueue({ entityType: "project", entityId: "c", mutation: "delete" });

    const listed = await queue.list();
    expect(listed.map((op) => op.entityId)).toEqual(["a", "b", "c"]);
    expect(listed.map((op) => op.seq)).toEqual([1, 2, 3]);
  });
});

describe("OfflineQueue durability", () => {
  it("survives re-instantiation from the same backing storage", async () => {
    const storage = new MemoryStore();
    const first = new OfflineQueue(storage);
    await first.enqueue({ entityType: "task", entityId: "task-1", mutation: "update" });

    // A brand-new queue over the same storage — nothing was kept in memory.
    const second = new OfflineQueue(storage);
    const listed = await second.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].entityId).toBe("task-1");
  });

  it("survives a reload (a fresh queue over the same localStorage)", async () => {
    globalThis.localStorage.clear();
    const reload = () =>
      new OfflineQueue(new LocalStorageStore("atlas.reload."), fixedClock());

    await reload().enqueue({
      entityType: "project",
      entityId: "project-9",
      mutation: "delete",
      baseRevision: 7,
    });

    // Simulate the page reloading: a completely new queue over the same durable storage.
    const afterReload = await reload().list();
    expect(afterReload).toHaveLength(1);
    expect(afterReload[0]).toMatchObject({
      entityType: "project",
      entityId: "project-9",
      mutation: "delete",
      baseRevision: 7,
    });
  });
});

describe("OfflineQueue state transitions", () => {
  it("summarises pending/conflict/failed counts", async () => {
    const queue = new OfflineQueue(new MemoryStore());
    const a = await queue.enqueue({ entityType: "task", entityId: "a", mutation: "create" });
    const b = await queue.enqueue({ entityType: "task", entityId: "b", mutation: "update" });
    await queue.enqueue({ entityType: "task", entityId: "c", mutation: "update" });

    await queue.markConflict(b.id, 9);
    await queue.markFailed(a.id, "bad request");

    const snapshot = await queue.snapshot();
    expect(snapshot.total).toBe(3);
    expect(snapshot.conflicts).toBe(1);
    expect(snapshot.failed).toBe(1);
    expect(snapshot.pending).toBe(1);
  });

  it("keeps a conflicted operation and records the server revision (never clobbers)", async () => {
    const queue = new OfflineQueue(new MemoryStore());
    const op = await queue.enqueue({ entityType: "task", entityId: "a", mutation: "update" });

    await queue.markConflict(op.id, 12);

    const listed = await queue.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].status).toBe("conflict");
    expect(listed[0].serverRevision).toBe(12);
  });

  it("records a retryable attempt while keeping the operation pending", async () => {
    const queue = new OfflineQueue(new MemoryStore());
    const op = await queue.enqueue({ entityType: "task", entityId: "a", mutation: "update" });

    await queue.recordAttempt(op.id, "Network error");

    const [listed] = await queue.list();
    expect(listed.status).toBe("pending");
    expect(listed.attempts).toBe(1);
    expect(listed.lastError).toBe("Network error");
  });

  it("removes an operation and clears the queue", async () => {
    const queue = new OfflineQueue(new MemoryStore());
    const op = await queue.enqueue({ entityType: "task", entityId: "a", mutation: "create" });
    await queue.remove(op.id);
    expect(await queue.list()).toEqual([]);

    await queue.enqueue({ entityType: "task", entityId: "b", mutation: "create" });
    await queue.clear();
    expect((await queue.snapshot()).total).toBe(0);
  });

  it("rebases a conflicted operation to a new revision and returns it to pending", async () => {
    const queue = new OfflineQueue(new MemoryStore());
    const op = await queue.enqueue({
      entityType: "task",
      entityId: "a",
      mutation: "update",
      baseRevision: 2,
      payload: { title: "kept" },
    });
    await queue.markConflict(op.id, 7);

    const rebased = await queue.rebase(op.id, 7);
    expect(rebased).toMatchObject({ status: "pending", baseRevision: 7, serverRevision: null });
    expect(rebased?.payload).toEqual({ title: "kept" }); // the edit is never lost

    // Idempotent: re-basing an already-pending operation is a no-op.
    expect(await queue.rebase(op.id, 7)).toMatchObject({ status: "pending", baseRevision: 7 });
  });

  it("keeps the original base revision when re-basing with an unknown server revision", async () => {
    const queue = new OfflineQueue(new MemoryStore());
    const op = await queue.enqueue({
      entityType: "task",
      entityId: "a",
      mutation: "update",
      baseRevision: 2,
    });
    await queue.markConflict(op.id, null);
    expect(await queue.rebase(op.id, null)).toMatchObject({ status: "pending", baseRevision: 2 });
  });
});

describe("OfflineQueue stored format", () => {
  it("discards a stored queue written by an unknown format version", async () => {
    const storage = new MemoryStore();
    await storage.write(
      "queue",
      JSON.stringify({ version: QUEUE_STORE_VERSION + 99, nextSeq: 5, operations: [] }),
    );
    const queue = new OfflineQueue(storage);
    expect(await queue.list()).toEqual([]);
  });

  it("starts clean when the stored blob is corrupt rather than crashing", async () => {
    const storage = new MemoryStore();
    await storage.write("queue", "{ not json");
    const queue = new OfflineQueue(storage);
    expect((await queue.snapshot()).total).toBe(0);
  });
});

describe("newIdempotencyKey", () => {
  it("returns a non-empty, unique key", () => {
    const a = newIdempotencyKey();
    const b = newIdempotencyKey();
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });
});
