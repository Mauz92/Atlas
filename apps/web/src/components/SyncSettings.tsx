import { useCallback } from "react";

import { SyncStatusPanel } from "./SyncStatusPanel";
import { useConflictResolution } from "../hooks/useConflictResolution";
import { useOfflineQueue } from "../hooks/useOfflineQueue";
import { useReconciliation } from "../hooks/useReconciliation";
import type { ConflictResolution } from "../lib/conflictResolution";
import type { CacheEntry } from "../lib/localCache";

/**
 * The Sync section of Settings (M7-03 queue status, M7-04 reconciliation, M7-05 status panel and
 * resolution; a page of its own until UX-08).
 *
 * Edits made while offline are held on this device and replayed when the connection returns; the
 * section shows an overall state, how many changes are pending/failed/conflicting, and any conflict a
 * stale write produced. "Sync now" runs a full reconciliation (replay the queue, then pull missed
 * changes). A conflict can be resolved per entity: **Keep mine** re-queues the local edit against the
 * server's latest revision, **Take server** discards it and adopts the server's version (ADR-0036);
 * the resolution itself lives in `lib`/hooks, so this only wires the primitives together.
 */
export function SyncSettings() {
  const { counts, operations, state, error, actionError, busy, refresh } = useOfflineQueue();
  const {
    conflicts,
    error: reconcileError,
    busy: reconciling,
    online,
    reconcile,
  } = useReconciliation();

  const syncNow = useCallback(async () => {
    await reconcile();
    await refresh();
  }, [reconcile, refresh]);

  const { resolvingKey, error: resolveError, resolve } = useConflictResolution({
    onResolved: syncNow,
  });

  const handleResolve = useCallback(
    (entry: CacheEntry, resolution: ConflictResolution) => {
      void resolve({ entityType: entry.entityType, entityId: entry.entityId }, resolution);
    },
    [resolve],
  );

  return (
    <SyncStatusPanel
      counts={counts}
      operations={operations}
      state={state}
      error={error}
      actionError={actionError}
      conflicts={conflicts}
      online={online}
      syncError={reconcileError}
      resolveError={resolveError}
      busy={busy || reconciling}
      resolvingKey={resolvingKey}
      onRefresh={() => void refresh()}
      onSyncNow={() => void syncNow()}
      onResolve={handleResolve}
    />
  );
}
