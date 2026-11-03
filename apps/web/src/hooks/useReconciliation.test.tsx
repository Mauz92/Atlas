import { act, renderHook, waitFor } from "@testing-library/react";

import { ApiError, type ChangeFeed } from "../api/client";
import { LocalCache } from "../lib/localCache";
import { OfflineQueue } from "../lib/offlineQueue";
import { MemoryStore } from "../lib/queueStorage";
import { Reconciler } from "../lib/reconciliation";
import { SyncCursorStore } from "../lib/syncEngine";
import { useReconciliation } from "./useReconciliation";

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

/** A reconciler over in-memory durable state with a spy for each network call. */
function makeReconciler(store = new MemoryStore()) {
  const queue = new OfflineQueue(store);
  const cursor = new SyncCursorStore(store);
  const cache = new LocalCache(store);
  const send = vi.fn(async () => {});
  const listChanges = vi.fn(async (since: number) => feed({ since, next_since: since }));
  return {
    store,
    queue,
    cursor,
    cache,
    send,
    listChanges,
    reconciler: new Reconciler({ queue, cursor, cache, send, listChanges }),
  };
}

describe("useReconciliation", () => {
  it("runs a reconciliation pass on mount", async () => {
    const { reconciler, listChanges } = makeReconciler();

    const { result } = renderHook(() => useReconciliation(reconciler));

    await waitFor(() => expect(listChanges).toHaveBeenCalledTimes(1));
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("re-reconciles when the browser comes back online and when the tab regains focus", async () => {
    const { reconciler, listChanges } = makeReconciler();

    renderHook(() => useReconciliation(reconciler));
    await waitFor(() => expect(listChanges).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(listChanges).toHaveBeenCalledTimes(2));

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(listChanges).toHaveBeenCalledTimes(3));
  });

  it("exposes the conflicts surfaced by a pass and reconciles on demand", async () => {
    const store = new MemoryStore();
    const { queue, cursor, cache } = makeReconciler(store);
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
        throw new ApiError(409, "stale revision", { detail: { current_revision: 9 } });
      },
      listChanges: async (since) => feed({ since, next_since: since }),
    });

    const { result } = renderHook(() => useReconciliation(reconciler));

    await waitFor(() => expect(result.current.conflicts).toHaveLength(1));
    expect(result.current.conflicts[0]).toMatchObject({ entityId: "task-1", serverRevision: 9 });

    // The manual action is safe to repeat and keeps the conflict surfaced (never dropped).
    await act(async () => {
      await result.current.reconcile();
    });
    expect(result.current.conflicts).toHaveLength(1);
  });

  it("surfaces a failed pass as an error", async () => {
    const store = new MemoryStore();
    const reconciler = new Reconciler({
      queue: new OfflineQueue(store),
      cursor: new SyncCursorStore(store),
      cache: new LocalCache(store),
      send: async () => {},
      listChanges: async () => {
        throw new Error("network down");
      },
    });

    const { result } = renderHook(() => useReconciliation(reconciler));

    await waitFor(() => expect(result.current.error).toBe("network down"));
  });
});
