import { act, renderHook, waitFor } from "@testing-library/react";

import { LocalCache } from "../lib/localCache";
import { OfflineQueue } from "../lib/offlineQueue";
import { MemoryStore } from "../lib/queueStorage";
import { useConflictResolution } from "./useConflictResolution";

function harness() {
  const store = new MemoryStore();
  const queue = new OfflineQueue(store);
  const cache = new LocalCache(store);
  return { store, queue, cache };
}

/** Queue a conflicted `task-1` operation and reflect it in the cache. */
async function queueConflict(queue: OfflineQueue, cache: LocalCache) {
  const op = await queue.enqueue({
    entityType: "task",
    entityId: "task-1",
    mutation: "update",
    baseRevision: 3,
  });
  await queue.markConflict(op.id, 9);
  await cache.markLocalState(await queue.list());
}

describe("useConflictResolution", () => {
  it("resolves a conflict over the queue/cache and runs onResolved", async () => {
    const { queue, cache } = harness();
    await queueConflict(queue, cache);
    const onResolved = vi.fn();

    const { result } = renderHook(() => useConflictResolution({ queue, cache, onResolved }));

    await act(async () => {
      await result.current.resolve({ entityType: "task", entityId: "task-1" }, "keep-mine");
    });

    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(result.current.resolvingKey).toBeNull();
    expect(result.current.error).toBeNull();
    expect((await queue.list())[0]).toMatchObject({ status: "pending", baseRevision: 9 });
    expect(await cache.conflicts()).toHaveLength(0);
  });

  it("exposes the entity being resolved while the action is in flight", async () => {
    const { queue, cache } = harness();
    await queueConflict(queue, cache);

    let release: () => void = () => {};
    const onResolved = () => new Promise<void>((resolve) => (release = resolve));

    const { result } = renderHook(() => useConflictResolution({ queue, cache, onResolved }));

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.resolve({ entityType: "task", entityId: "task-1" }, "take-server");
    });

    await waitFor(() => expect(result.current.resolvingKey).toBe("task:task-1"));

    await act(async () => {
      release();
      await pending;
    });
    expect(result.current.resolvingKey).toBeNull();
  });

  it("surfaces a resolution failure as an error", async () => {
    const { queue } = harness();
    const cache = {
      markLocalState: async () => {
        throw new Error("storage down");
      },
    } as unknown as LocalCache;

    const { result } = renderHook(() => useConflictResolution({ queue, cache }));

    await act(async () => {
      await result.current.resolve({ entityType: "task", entityId: "task-1" }, "take-server");
    });

    expect(result.current.error).toBe("storage down");
    expect(result.current.resolvingKey).toBeNull();
  });
});
