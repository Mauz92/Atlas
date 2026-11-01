import { useCallback } from "react";

import { SyncStatusPanel } from "../components/SyncStatusPanel";
import { useConflictResolution } from "../hooks/useConflictResolution";
import { useOfflineQueue } from "../hooks/useOfflineQueue";
import { useReconciliation } from "../hooks/useReconciliation";
import type { ConflictResolution } from "../lib/conflictResolution";
import type { CacheEntry } from "../lib/localCache";

/**
 * The Sync route (M7-03 queue status + M7-04 reconciliation + M7-05 status panel & resolution).
 *
 * Edits made while offline are held on this device and replayed when the connection returns; the page
 * shows an overall state, how many changes are pending/failed/conflicting, and any conflict a stale
 * write produced. "Sync now" runs a full reconciliation (replay the queue, then pull missed changes).
 * A conflict can be resolved per entity — **Keep mine** re-queues the local edit against the server's
 * latest revision, **Take server** discards it and adopts the server's version (see ADR-0036); the
 * resolution itself lives in `lib`/hooks, so the page only wires the primitives together.
 */
export function SyncPage() {
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
    <section className="page sync-page">
      <h1>Sync</h1>
      <p className="muted">
        Changes you make offline are stored on this device and sent automatically when the connection
        returns. If an item changed on the server in the meantime, your edit is kept so you can decide
        what to do.
      </p>
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
    </section>
  );
}
