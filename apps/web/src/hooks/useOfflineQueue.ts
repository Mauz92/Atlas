import { useCallback, useEffect, useState } from "react";

import { flushQueue } from "../lib/syncEngine";
import {
  getOfflineQueue,
  type OfflineQueue,
  type QueueSnapshot,
  type QueuedOperation,
} from "../lib/offlineQueue";
import type { QueueCounts } from "../lib/queueStatus";
import type { LoadState } from "./useTaskView";

/** The empty snapshot the hook renders before the first load resolves. */
const EMPTY: QueueSnapshot = { operations: [], total: 0, pending: 0, conflicts: 0, failed: 0 };

export interface OfflineQueueResult {
  /** The queue's pending/conflict/failed counts (M7-05 builds its status UI on these). */
  counts: QueueCounts;
  /** The queued operations, in FIFO order. */
  operations: QueuedOperation[];
  state: LoadState;
  /** A failure reading the queue from storage. */
  error: string | null;
  /** A failure from a manual "sync now" replay. */
  actionError: string | null;
  /** True while a manual replay is in flight. */
  busy: boolean;
  refresh: () => Promise<void>;
  /** Replay the queue once through the API (a manual reconnect). */
  flush: () => Promise<void>;
}

/**
 * Read the durable offline queue and expose its state for the status surface (M7-03).
 *
 * All the queue logic lives in `lib/offlineQueue.ts`/`lib/syncEngine.ts`; the hook only loads the
 * snapshot and relays a manual replay. It takes the queue as an argument so it can be tested over an
 * in-memory queue, defaulting to the app-wide durable instance.
 */
export function useOfflineQueue(queue: OfflineQueue = getOfflineQueue()): OfflineQueueResult {
  const [snapshot, setSnapshot] = useState<QueueSnapshot>(EMPTY);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSnapshot(await queue.snapshot());
      setError(null);
      setState("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read the offline queue");
      setState("error");
    }
  }, [queue]);

  const refresh = useCallback(async () => {
    setState("loading");
    await load();
  }, [load]);

  const flush = useCallback(async () => {
    setActionError(null);
    setBusy(true);
    try {
      await flushQueue(queue);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not sync queued changes");
    } finally {
      setBusy(false);
    }
  }, [load, queue]);

  useEffect(() => {
    void load();
  }, [load]);

  return {
    counts: {
      total: snapshot.total,
      pending: snapshot.pending,
      conflicts: snapshot.conflicts,
      failed: snapshot.failed,
    },
    operations: snapshot.operations,
    state,
    error,
    actionError,
    busy,
    refresh,
    flush,
  };
}
