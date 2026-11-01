import { act, renderHook, waitFor } from "@testing-library/react";

import { OfflineQueue } from "../lib/offlineQueue";
import { MemoryStore } from "../lib/queueStorage";
import { useOfflineQueue } from "./useOfflineQueue";

describe("useOfflineQueue", () => {
  it("loads the queue counts from a durable queue", async () => {
    const queue = new OfflineQueue(new MemoryStore());
    await queue.enqueue({ entityType: "task", entityId: "a", mutation: "update" });
    await queue.enqueue({ entityType: "task", entityId: "b", mutation: "create" });

    const { result } = renderHook(() => useOfflineQueue(queue));

    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(result.current.counts).toMatchObject({ total: 2, pending: 2 });
    expect(result.current.operations).toHaveLength(2);
  });

  it("re-reads the queue on refresh", async () => {
    const queue = new OfflineQueue(new MemoryStore());
    const { result } = renderHook(() => useOfflineQueue(queue));
    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(result.current.counts.total).toBe(0);

    await queue.enqueue({ entityType: "project", entityId: "p", mutation: "delete" });
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.counts.total).toBe(1);
  });
});
