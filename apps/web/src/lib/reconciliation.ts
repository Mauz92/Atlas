/**
 * Reconnect reconciliation (M7-04).
 *
 * When connectivity returns — the browser fires `online`, the tab regains `focus`, or the user asks
 * to sync — the client runs one **reconciliation pass** that keeps it eventually consistent without
 * ever losing or duplicating the user's work (`PRODUCT_SPEC.md` §5.5, `AGENTS.md` §9):
 *
 * 1. **Reflect** the durable queue in the {@link LocalCache} *before* replaying, so an entity with a
 *    queued edit is never shown as fully synced while the replay is in flight.
 * 2. **Flush** the queue through the M7-03 replay (`flushQueue`) — FIFO, `Idempotency-Key`-keyed,
 *    `base_revision`-aware. A retry reuses the same key, so it never duplicates.
 * 3. **Surface** the outcome in the cache: a replayed edit clears, and a stale `409` stays a
 *    `conflict` — the local edit is **kept**, the server is **never clobbered** (ADR-0035).
 * 4. **Pull** what changed elsewhere (`GET /api/changes`) from the stored cursor and apply it to the
 *    cache; when the server answers `resync_required` the cache is dropped and the client resumes
 *    from the server's head instead of trusting a partial feed (ADR-0033).
 *
 * **Ordering is deliberate: flush, then pull.** Draining the queue first means an entity whose local
 * edit just landed is removed from the queue *before* its own server change is pulled, so the client
 * does not re-apply its own write as a "remote" change or manufacture a self-conflict; and a conflict
 * from the flush is surfaced before the pull updates the cache, so the pull never hides it.
 *
 * **Idempotence.** Re-running a pass is safe: the flush only re-sends `pending` operations (a landed
 * one is already gone, a conflict/failed one is not retried blindly), the pull resumes from the
 * advanced cursor (delivering nothing new), and `applyChanges`/`markLocalState` are stable to re-run.
 *
 * Everything here is injectable so the pass is unit-testable without a network; the component layer
 * only renders the result (business logic stays out of components, AGENTS.md §6).
 */

import { changesApi, type ChangeFeed } from "../api/client";
import { getOfflineQueue, type OfflineQueue, type QueuedOperation } from "./offlineQueue";
import { getSharedDurableStore } from "./queueStorage";
import {
  flushQueue,
  getSyncCursor,
  pullChanges,
  sendOperation,
  SyncCursorStore,
  type FlushResult,
  type PullResult,
} from "./syncEngine";
import { getLocalCache, LocalCache, type CacheEntry, type CacheSnapshot } from "./localCache";

/** Everything a reconciliation pass needs, wired to the real API by default. */
export interface ReconcileDeps {
  queue: OfflineQueue;
  cursor: SyncCursorStore;
  cache: LocalCache;
  /** How to replay one queued operation. Defaults to the M7-03 {@link sendOperation}. */
  send?: (operation: QueuedOperation) => Promise<void>;
  /** Page the change feed from a cursor. Defaults to `GET /api/changes`. */
  listChanges?: (since: number) => Promise<ChangeFeed>;
  /** Extra work on a full resync (the cache is dropped before this runs). */
  fullResync?: () => Promise<void> | void;
}

/** The outcome of one reconciliation pass. */
export interface ReconcileResult {
  /** What the flush (queue replay) did. */
  flush: FlushResult;
  /** What the pull (change feed) did. */
  pull: PullResult;
  /** The conflicts to surface: local edits kept, the server never clobbered. */
  conflicts: CacheEntry[];
  /** The cache after the pass. */
  cache: CacheSnapshot;
}

/**
 * Run one reconciliation pass: flush the durable queue, then pull missed changes into the cache.
 *
 * See the module doc for the ordering and idempotence guarantees. Never throws for an expected
 * offline condition: a network failure leaves the queue intact for the next pass, and a conflict is
 * returned in `conflicts`, not raised.
 */
export async function reconcile(deps: ReconcileDeps): Promise<ReconcileResult> {
  // 1. Reflect the queue in the cache before replaying so nothing looks synced mid-pass.
  await deps.cache.markLocalState(await deps.queue.list());

  // 2. Replay the durable queue (M7-03): FIFO, idempotency-keyed, conflict-safe.
  const flush = await flushQueue(deps.queue, deps.send ?? sendOperation);

  // 3. Re-derive the queue-owned flags: an applied op clears, a stale 409 stays a kept conflict.
  await deps.cache.markLocalState(await deps.queue.list());

  // 4. Pull what changed elsewhere and apply it. On `resync_required` drop the (possibly stale)
  //    cache and resume from the server's head instead of a partial feed.
  const pull = await pullChanges({
    cursor: deps.cursor,
    listChanges: deps.listChanges ?? ((since) => changesApi.list({ since })),
    fullResync: async () => {
      await deps.cache.clear();
      // Re-apply the local queue state so a kept edit is still surfaced after the cache is dropped.
      await deps.cache.markLocalState(await deps.queue.list());
      if (deps.fullResync) {
        await deps.fullResync();
      }
    },
    onChanges: (changes) => deps.cache.applyChanges(changes),
  });

  const cache = await deps.cache.snapshot();
  return { flush, pull, conflicts: cache.entries.filter((entry) => entry.conflict), cache };
}

/** A thin binder so the app (and the reconnect hook) can run a pass over the shared durable state. */
export class Reconciler {
  constructor(private readonly deps: ReconcileDeps) {}

  /** Run one reconciliation pass. */
  run(): Promise<ReconcileResult> {
    return reconcile(this.deps);
  }

  /** The conflicts currently surfaced in the cache. */
  conflicts(): Promise<CacheEntry[]> {
    return this.deps.cache.conflicts();
  }
}

let sharedReconciler: Reconciler | null = null;

/** The app-wide reconciler, wired to the real queue, cursor, cache and API. */
export function getReconciler(): Reconciler {
  if (!sharedReconciler) {
    // Touch the shared store first so the queue, cursor and cache all sit on one durable backing.
    getSharedDurableStore();
    sharedReconciler = new Reconciler({
      queue: getOfflineQueue(),
      cursor: getSyncCursor(),
      cache: getLocalCache(),
    });
  }
  return sharedReconciler;
}

/* -------------------------------------------------------------------------------------------------
 * Presentation helpers (wording/formatting only — the component renders state, AGENTS.md §6)
 * ----------------------------------------------------------------------------------------------- */

const ENTITY_LABELS: Record<string, string> = {
  task: "task",
  project: "project",
  note: "note",
  note_project_link: "note link",
  task_note_link: "task link",
};

/** A short, human label for a conflicted entity, e.g. `task 3f2c…`. */
export function conflictEntityLabel(entry: CacheEntry): string {
  const entity = ENTITY_LABELS[entry.entityType] ?? entry.entityType;
  return `${entity} ${entry.entityId}`;
}

/** A one-line explanation of what a surfaced conflict means (keep-local + manual resolution later). */
export function conflictDetailText(entry: CacheEntry): string {
  return entry.serverRevision === null
    ? "This item changed on the server. Your edit was kept and will not overwrite it."
    : `This item is now at revision ${entry.serverRevision} on the server. Your edit was kept and will not overwrite it.`;
}

/** The summary line for the conflict surface. */
export function conflictSummaryText(conflicts: CacheEntry[]): string {
  if (conflicts.length === 0) {
    return "No sync conflicts.";
  }
  if (conflicts.length === 1) {
    return "1 of your changes could not be applied because the item changed on the server.";
  }
  return `${conflicts.length} of your changes could not be applied because those items changed on the server.`;
}
