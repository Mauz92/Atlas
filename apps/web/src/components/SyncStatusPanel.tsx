import type { LoadState } from "../hooks/useTaskView";
import type { CacheEntry } from "../lib/localCache";
import type { QueuedOperation } from "../lib/offlineQueue";
import type { ConflictResolution } from "../lib/conflictResolution";
import {
  overallSyncDescription,
  overallSyncLabel,
  overallSyncState,
  type QueueCounts,
} from "../lib/queueStatus";
import { ConflictNotice } from "./ConflictNotice";
import { OfflineQueueStatus } from "./OfflineQueueStatus";

interface SyncStatusPanelProps {
  /** Pending/failed/conflict counts from `useOfflineQueue`. */
  counts: QueueCounts;
  /** The queued operations, in FIFO order. */
  operations: QueuedOperation[];
  /** The offline queue's load state. */
  state: LoadState;
  /** A failure reading the queue. */
  error: string | null;
  /** A failure from a manual replay. */
  actionError?: string | null;
  /** The conflicts surfaced by `useReconciliation`. */
  conflicts: CacheEntry[];
  /** `navigator.onLine` from `useReconciliation`. */
  online: boolean;
  /** A failure from a reconciliation pass. */
  syncError?: string | null;
  /** A failure from a conflict resolution. */
  resolveError?: string | null;
  /** True while any sync/replay/resolution is in flight. */
  busy?: boolean;
  /** The conflict entity currently being resolved (`type:id`), if any. */
  resolvingKey?: string | null;
  onRefresh: () => void;
  /** Run a full sync now (replay the queue, then pull changes). */
  onSyncNow?: () => void;
  /** Apply a manual resolution to one conflicting entity. */
  onResolve?: (entry: CacheEntry, resolution: ConflictResolution) => void;
}

/**
 * The full sync-status panel (M7-05).
 *
 * One surface that answers "am I synced?": a single **overall state** badge (up to date / syncing /
 * offline / error / conflicts), the pending/failed/conflict **counts**, the queued operations, and
 * the conflicts with a **manual resolution** action per entity.
 *
 * It is presentational: every value comes from `useOfflineQueue`/`useReconciliation`/
 * `useConflictResolution` (business logic stays in `lib`/`hooks`, AGENTS.md §6), and it composes the
 * existing `OfflineQueueStatus` and `ConflictNotice` surfaces rather than re-implementing them. The
 * overall badge is an `aria-live` region (the queue surface keeps its own `role="status"` badge), so
 * state changes are announced to screen readers without duplicating the status role.
 *
 * The counts are hidden while the queue cannot be read (its load error is shown instead), so a stale
 * count is never presented as fact. Light/dark themes and keyboard use are covered by the composed
 * surfaces and the theme variables in `styles.css`.
 */
export function SyncStatusPanel({
  counts,
  operations,
  state,
  error,
  actionError = null,
  conflicts,
  online,
  syncError = null,
  resolveError = null,
  busy = false,
  resolvingKey = null,
  onRefresh,
  onSyncNow,
  onResolve,
}: SyncStatusPanelProps) {
  const overall = overallSyncState({ counts, online, busy, loadFailed: state === "error" });

  return (
    <div className="sync-panel">
      <div className="sync-panel-overall" aria-live="polite" aria-atomic="true">
        <span className={`pill${overall === "error" || overall === "conflicts" ? " pill-danger" : overall === "up-to-date" ? " pill-success" : ""} sync-panel-badge sync-panel-badge-${overall}`}>
          {overallSyncLabel(overall)}
        </span>
        <span className="muted">{overallSyncDescription(overall)}</span>
      </div>

      {state === "error" ? null : (
        <dl className="sync-panel-counts">
          <div className="sync-panel-count">
            <dt>Pending</dt>
            <dd>{counts.pending}</dd>
          </div>
          <div className="sync-panel-count">
            <dt>Failed</dt>
            <dd>{counts.failed}</dd>
          </div>
          <div className="sync-panel-count">
            <dt>Conflicts</dt>
            <dd>{counts.conflicts}</dd>
          </div>
        </dl>
      )}

      <OfflineQueueStatus
        counts={counts}
        operations={operations}
        state={state}
        error={error}
        actionError={actionError}
        busy={busy}
        onRefresh={onRefresh}
        onSyncNow={onSyncNow}
      />

      <ConflictNotice
        conflicts={conflicts}
        error={syncError ?? resolveError ?? null}
        onReconcile={onSyncNow}
        onResolve={onResolve}
        resolvingKey={resolvingKey}
        busy={busy}
      />
    </div>
  );
}
