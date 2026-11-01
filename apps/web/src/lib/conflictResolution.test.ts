import { ApiError } from "../api/client";
import { LocalCache } from "./localCache";
import { OfflineQueue, type QueuedOperation } from "./offlineQueue";
import { flushQueue } from "./syncEngine";
import { MemoryStore } from "./queueStorage";
import {
  conflictRef,
  conflictRefKey,
  resolutionHint,
  resolutionLabel,
  resolveConflict,
} from "./conflictResolution";

/** A queue + cache over one shared durable backing (as in the browser). */
function harness() {
  const store = new MemoryStore();
  const queue = new OfflineQueue(store);
  const cache = new LocalCache(store);
  return { store, queue, cache };
}

/** Put one conflicted operation for `task-1` in the queue and reflect it in the cache. */
async function queueConflict(queue: OfflineQueue, cache: LocalCache) {
  const op = await queue.enqueue({
    entityType: "task",
    entityId: "task-1",
    mutation: "update",
    baseRevision: 3,
    payload: { title: "Edited offline" },
  });
  await queue.markConflict(op.id, 9);
  await cache.markLocalState(await queue.list());
  return op;
}

const taskRef = { entityType: "task", entityId: "task-1" } as const;

describe("resolveConflict — keep mine", () => {
  it("re-queues the local edit against the server's revision and clears the conflict", async () => {
    const { queue, cache } = harness();
    await queueConflict(queue, cache);

    const outcome = await resolveConflict(queue, cache, conflictRef({ ...taskRef }), "keep-mine");

    expect(outcome).toMatchObject({
      entityType: "task",
      entityId: "task-1",
      resolution: "keep-mine",
      affected: 1,
      unchanged: false,
    });

    // The operation is back to pending with the server's current revision as its new base.
    const [op] = await queue.list();
    expect(op).toMatchObject({ status: "pending", baseRevision: 9, serverRevision: null });
    // The local edit is never lost: the payload is untouched.
    expect(op.payload).toEqual({ title: "Edited offline" });
    // The conflict is cleared from the cache.
    expect(await cache.get("task", "task-1")).toMatchObject({
      conflict: false,
      localPending: true,
    });
  });

  it("keeps the original base revision when the server revision is unknown", async () => {
    const { queue, cache } = harness();
    const op = await queue.enqueue({
      entityType: "task",
      entityId: "task-1",
      mutation: "update",
      baseRevision: 3,
    });
    await queue.markConflict(op.id, null);
    await cache.markLocalState(await queue.list());

    await resolveConflict(queue, cache, taskRef, "keep-mine");

    // Re-queued unchanged so the next flush re-attempts and re-learns the revision — never lost.
    expect((await queue.list())[0]).toMatchObject({ status: "pending", baseRevision: 3 });
  });

  it("unblocks the next flush: the rebased operation is accepted", async () => {
    const { queue, cache } = harness();
    await queueConflict(queue, cache);

    // A server that accepts a write only when it is based on its current revision (9).
    const serverRevision = 9;
    const send = vi.fn(async (operation: QueuedOperation) => {
      if (operation.baseRevision !== serverRevision) {
        throw new ApiError(409, "stale revision", { detail: { current_revision: serverRevision } });
      }
    });

    // Before resolving, a flush is rejected (stale base_revision 3 → 409) and keeps the edit.
    const before = await flushQueue(queue, send);
    expect(before.sent).toBe(0);
    expect((await queue.list())[0].status).toBe("conflict");

    await resolveConflict(queue, cache, taskRef, "keep-mine");
    await cache.markLocalState(await queue.list());

    const after = await flushQueue(queue, send);
    expect(after.sent).toBe(1);
    expect((await queue.snapshot()).total).toBe(0);
    expect(await cache.conflicts()).toHaveLength(0);
  });
});

describe("resolveConflict — take server", () => {
  it("discards the local edit and adopts the server state", async () => {
    const { queue, cache } = harness();
    await queueConflict(queue, cache);

    const outcome = await resolveConflict(queue, cache, taskRef, "take-server");

    expect(outcome).toMatchObject({ resolution: "take-server", affected: 1, unchanged: false });
    // The local operation is gone…
    expect(await queue.snapshot()).toMatchObject({ total: 0 });
    // …and the entity no longer carries a local override in the cache.
    expect(await cache.get("task", "task-1")).toMatchObject({
      conflict: false,
      localPending: false,
    });
  });
});

describe("resolveConflict — idempotence and scoping", () => {
  it("is idempotent: resolving an already-resolved conflict twice is a no-op", async () => {
    const { queue, cache } = harness();
    await queueConflict(queue, cache);

    const first = await resolveConflict(queue, cache, taskRef, "keep-mine");
    const afterFirst = await queue.snapshot();

    const second = await resolveConflict(queue, cache, taskRef, "keep-mine");
    const afterSecond = await queue.snapshot();

    expect(first.unchanged).toBe(false);
    expect(second.unchanged).toBe(true);
    expect(second.affected).toBe(0);
    expect(afterSecond).toEqual(afterFirst); // nothing changed the second time
  });

  it("is idempotent for take-server as well", async () => {
    const { queue, cache } = harness();
    await queueConflict(queue, cache);

    await resolveConflict(queue, cache, taskRef, "take-server");
    const second = await resolveConflict(queue, cache, taskRef, "take-server");

    expect(second).toMatchObject({ affected: 0, unchanged: true });
    expect(await queue.snapshot()).toMatchObject({ total: 0 });
  });

  it("never touches another entity's queued operation", async () => {
    const { queue, cache } = harness();
    await queueConflict(queue, cache);
    await queue.enqueue({ entityType: "project", entityId: "project-1", mutation: "create" });
    await cache.markLocalState(await queue.list());

    await resolveConflict(queue, cache, taskRef, "take-server");

    const remaining = await queue.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ entityType: "project", entityId: "project-1" });
  });
});

describe("conflict-resolution helpers", () => {
  it("builds a stable key from an entity ref", () => {
    expect(conflictRefKey({ entityType: "task", entityId: "abc" })).toBe("task:abc");
    expect(conflictRef({ entityType: "project", entityId: "p1" })).toEqual({
      entityType: "project",
      entityId: "p1",
    });
  });

  it("labels and explains each resolution", () => {
    expect(resolutionLabel("keep-mine")).toBe("Keep mine");
    expect(resolutionLabel("take-server")).toBe("Take server");
    expect(resolutionHint("keep-mine")).toMatch(/latest revision/i);
    expect(resolutionHint("take-server")).toMatch(/server's version/i);
  });
});
