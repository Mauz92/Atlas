import { useCallback, useState } from "react";

import {
  conflictRefKey,
  resolveConflict,
  type ConflictRef,
  type ConflictResolution,
  type ResolveOutcome,
} from "../lib/conflictResolution";
import { getLocalCache, type LocalCache } from "../lib/localCache";
import { getOfflineQueue, type OfflineQueue } from "../lib/offlineQueue";

export interface ConflictResolutionDeps {
  /** The durable queue to act on. Defaults to the app-wide instance. */
  queue?: OfflineQueue;
  /** The durable cache to re-derive flags on. Defaults to the app-wide instance. */
  cache?: LocalCache;
  /** Called after a resolution lands — refresh the counts and re-derive the surfaced conflicts. */
  onResolved?: (outcome: ResolveOutcome) => Promise<void> | void;
}

export interface ConflictResolutionResult {
  /** The entity currently being resolved (`type:id`), or `null` when idle. */
  resolvingKey: string | null;
  /** A failure from a resolution (kept off the conflict list so the last-known state stays visible). */
  error: string | null;
  /** Apply a resolution to one conflicting entity. */
  resolve: (ref: ConflictRef, resolution: ConflictResolution) => Promise<void>;
}

/**
 * Apply a manual conflict resolution (M7-05).
 *
 * All the logic lives in `lib/conflictResolution.ts`; the hook only tracks the in-flight entity and
 * relays a failure, then runs the caller's `onResolved` so the queue counts and the surfaced
 * conflicts are re-read from the primitives (business logic stays out of components, AGENTS.md §6).
 * It takes its queue/cache as arguments so it can be tested over in-memory state, defaulting to the
 * app-wide durable instances.
 */
export function useConflictResolution(
  deps: ConflictResolutionDeps = {},
): ConflictResolutionResult {
  const queue = deps.queue ?? getOfflineQueue();
  const cache = deps.cache ?? getLocalCache();
  const onResolved = deps.onResolved;

  const [resolvingKey, setResolvingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resolve = useCallback(
    async (ref: ConflictRef, resolution: ConflictResolution) => {
      setError(null);
      setResolvingKey(conflictRefKey(ref));
      try {
        const outcome = await resolveConflict(queue, cache, ref, resolution);
        if (onResolved) {
          await onResolved(outcome);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not resolve the conflict");
      } finally {
        setResolvingKey(null);
      }
    },
    [cache, onResolved, queue],
  );

  return { resolvingKey, error, resolve };
}
