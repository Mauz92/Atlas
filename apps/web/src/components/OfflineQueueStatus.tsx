import type { LoadState } from "../hooks/useTaskView";
import type { QueuedOperation } from "../lib/offlineQueue";
import {
  operationLabel,
  operationStatusLabel,
  queueStatusKind,
  queueStatusLabel,
  queueSummaryText,
  type QueueCounts,
} from "../lib/queueStatus";
import { LoadError } from "./LoadError";

interface OfflineQueueStatusProps {
  counts: QueueCounts;
  /** The queued operations, in FIFO order. */
  operations: QueuedOperation[];
  state: LoadState;
  /** A failure reading the queue. */
  error: string | null;
  /** A failure from a manual replay. */
  actionError?: string | null;
  /** True while a manual replay is in flight. */
  busy?: boolean;
  onRefresh: () => void;
  /** Replay the queue now (a manual reconnect). */
  onSyncNow?: () => void;
}

/**
 * The minimal offline-queue status surface (M7-03): how many edits are waiting to sync and what state
 * the queue is in. M7-05 grows the full sync-status UI on top of this.
 *
 * Presentational only — it renders the `useOfflineQueue` result and never touches storage or the API
 * (business logic stays in `lib/`, AGENTS.md §6). Loading, error, empty and conflict states are
 * explicit, the badge has `role="status"`, and the actions are focusable buttons that disable while
 * a replay is in flight, so the surface is usable by keyboard and screen readers in light and dark
 * themes.
 */
export function OfflineQueueStatus({
  counts,
  operations,
  state,
  error,
  actionError = null,
  busy = false,
  onRefresh,
  onSyncNow,
}: OfflineQueueStatusProps) {
  if (state === "loading") {
    return <p className="muted" role="status">Loading offline queue…</p>;
  }
  if (state === "error") {
    return <LoadError message={error} onRetry={onRefresh} />;
  }

  const kind = queueStatusKind(counts);

  return (
    <div className="offline-queue">
      {actionError ? (
        <p className="error" role="alert">
          {actionError}
        </p>
      ) : null}

      <div className="offline-queue-summary">
        <span className={`pill${kind === "conflict" || kind === "failed" ? " pill-danger" : kind === "all" ? " pill-success" : ""} offline-queue-badge offline-queue-badge-${kind}`} role="status">
          {queueStatusLabel(counts)}
        </span>
        <p className="muted">{queueSummaryText(counts)}</p>
        <div className="offline-queue-actions">
          <button type="button" onClick={onRefresh} disabled={busy}>
            Refresh
          </button>
          {counts.pending > 0 && onSyncNow ? (
            <button type="button" onClick={onSyncNow} disabled={busy} aria-busy={busy}>
              {busy ? "Syncing…" : "Sync now"}
            </button>
          ) : null}
        </div>
      </div>

      {operations.length > 0 ? (
        <ul className="offline-queue-list">
          {operations.map((operation) => (
            <li key={operation.id} className="offline-queue-item">
              <span className="offline-queue-label">{operationLabel(operation)}</span>
              <span className={`offline-queue-state offline-queue-state-${operation.status}`}>
                {operationStatusLabel(operation.status)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty-state">You are up to date. Changes made offline appear here.</div>
      )}
    </div>
  );
}
