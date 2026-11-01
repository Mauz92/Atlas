import type { CacheEntry } from "../lib/localCache";
import type { QueuedOperation } from "../lib/offlineQueue";

/** A complete `CacheEntry` with sensible defaults, for cache/conflict-surface tests (M7-04). */
export function makeCacheEntry(overrides: Partial<CacheEntry> = {}): CacheEntry {
  return {
    entityType: "task",
    entityId: "task-1",
    cursor: 5,
    deleted: false,
    changedAt: "2026-10-27T09:00:00.000Z",
    localPending: true,
    conflict: true,
    serverRevision: 9,
    updatedAt: "2026-10-27T09:00:00.000Z",
    ...overrides,
  };
}

/** A complete `QueuedOperation` with sensible defaults, for queue/status tests. */
export function makeQueuedOperation(overrides: Partial<QueuedOperation> = {}): QueuedOperation {
  return {
    id: "op-1",
    seq: 1,
    entityType: "task",
    entityId: "task-1",
    mutation: "update",
    idempotencyKey: "idem-1",
    baseRevision: 3,
    payload: { title: "Edited offline" },
    createdAt: "2026-10-27T09:00:00.000Z",
    attempts: 0,
    status: "pending",
    lastError: null,
    serverRevision: null,
    ...overrides,
  };
}
