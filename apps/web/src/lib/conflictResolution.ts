/**
 * Manual conflict resolution (M7-05).
 *
 * Reconnect reconciliation (M7-04) **keeps** a stale local edit and *surfaces* it — it never guesses
 * a winner and never clobbers newer server data (AGENTS.md §9, ADR-0035). This module adds the two
 * user-facing resolutions on top of the existing queue/cache primitives; it invents no new state and
 * duplicates none of their logic (AGENTS.md §6/§7.4).
 *
 * Semantics (see ADR-0036):
 *
 * - **"keep mine"** — re-queue the conflicting local operation against the **server's current
 *   revision** as its new `base_revision`, returning it to `pending` so the next flush is accepted
 *   instead of rejected with a stale `409`. The queued payload is untouched, so the user's edit is
 *   never lost. When the server revision is unknown the operation is returned to `pending`
 *   *unchanged*, so the next flush re-attempts it and re-learns the revision from the resulting
 *   `409` — the client still never sends an unchecked write.
 * - **"take server"** — discard the conflicting local operation and adopt the server's state: the
 *   local-pending/conflict flags on the entity's cache entry are cleared, so the client stops
 *   holding a local override for it.
 *
 * Both actions are **idempotent**. Resolution is defined over the operations currently in the
 * `conflict` state for one entity, so resolving an already-resolved conflict changes nothing
 * (`unchanged: true`); the queue-owned cache flags are then re-derived by `markLocalState`, which is
 * itself stable to re-run.
 */

import type { CacheEntry } from "./localCache";
import type { LocalCache } from "./localCache";
import { type OfflineQueue, type QueuedOperation } from "./offlineQueue";

/** The two resolutions a user can choose for a conflicting entity. */
export type ConflictResolution = "keep-mine" | "take-server";

/** Identifies one conflicting entity (the unit the conflict surface resolves). */
export interface ConflictRef {
  entityType: string;
  entityId: string;
}

/** A stable key for a conflict, e.g. `task:task-1` (used to mark the entity being resolved). */
export function conflictRefKey(ref: ConflictRef): string {
  return `${ref.entityType}:${ref.entityId}`;
}

/** The outcome of one resolution — what changed, and whether it was a no-op. */
export interface ResolveOutcome {
  entityType: string;
  entityId: string;
  resolution: ConflictResolution;
  /** Operations re-queued ("keep mine") or discarded ("take server"). */
  affected: number;
  /** True when there was nothing to resolve (already resolved) — the idempotent no-op case. */
  unchanged: boolean;
}

/** Build a {@link ConflictRef} from a cache entry (the conflict surface resolves cache entries). */
export function conflictRef(entity: Pick<CacheEntry, "entityType" | "entityId">): ConflictRef {
  return { entityType: entity.entityType, entityId: entity.entityId };
}

/** The conflicting operations the orchestrator may act on: matching entity, `conflict` state only. */
function conflictingOperations(
  operations: QueuedOperation[],
  ref: ConflictRef,
): QueuedOperation[] {
  return operations.filter(
    (op) =>
      op.entityType === ref.entityType &&
      op.entityId === ref.entityId &&
      op.status === "conflict",
  );
}

/**
 * Resolve one entity's conflict.
 *
 * Acts only on the operations currently in the `conflict` state for `ref`, so an unrelated queued
 * edit for the same entity is left alone. Afterwards the queue-owned cache flags are re-derived from
 * the queue (the ruled-out conflict clears exactly when the operation leaves `conflict`). Returns how
 * many operations were touched and whether the call was a no-op (already resolved).
 */
export async function resolveConflict(
  queue: OfflineQueue,
  cache: LocalCache,
  ref: ConflictRef,
  resolution: ConflictResolution,
): Promise<ResolveOutcome> {
  const operations = await queue.list();
  const conflicting = conflictingOperations(operations, ref);

  if (resolution === "take-server") {
    // Discard the kept local edits and adopt the server's state for this entity.
    for (const operation of conflicting) {
      await queue.remove(operation.id);
    }
  } else {
    // Rebase the kept local edits onto the server's current revision so the next flush succeeds.
    for (const operation of conflicting) {
      await queue.rebase(operation.id, operation.serverRevision);
    }
  }

  // Re-derive the queue-owned flags so the surfaced conflict clears iff the queue no longer holds it.
  await cache.markLocalState(await queue.list());

  return {
    entityType: ref.entityType,
    entityId: ref.entityId,
    resolution,
    affected: conflicting.length,
    unchanged: conflicting.length === 0,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Presentation helpers (wording only — the components render state, AGENTS.md §6)
 * ------------------------------------------------------------------------------------------------- */

const RESOLUTION_LABELS: Record<ConflictResolution, string> = {
  "keep-mine": "Keep mine",
  "take-server": "Take server",
};

const RESOLUTION_HINTS: Record<ConflictResolution, string> = {
  "keep-mine": "Send my version again using the server's latest revision.",
  "take-server": "Discard my change and use the server's version.",
};

/** A short label for a resolution action, e.g. "Keep mine". */
export function resolutionLabel(resolution: ConflictResolution): string {
  return RESOLUTION_LABELS[resolution];
}

/** A one-line explanation of what a resolution action does. */
export function resolutionHint(resolution: ConflictResolution): string {
  return RESOLUTION_HINTS[resolution];
}
