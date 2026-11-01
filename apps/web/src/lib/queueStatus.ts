/**
 * Presentation helpers for the offline-queue status surface (M7-03).
 *
 * All wording/formatting lives here so the component stays presentational (AGENTS.md §6). These
 * functions label the queue's *counts*; the queue itself (`offlineQueue.ts`) owns the state.
 */

import type { MutationKind, OperationStatus, QueuedOperation } from "./offlineQueue";

/** The counts the status surface renders. */
export interface QueueCounts {
  total: number;
  pending: number;
  conflicts: number;
  failed: number;
}

const MUTATION_LABELS: Record<MutationKind, string> = {
  create: "Create",
  update: "Update",
  delete: "Delete",
};

const ENTITY_LABELS: Record<string, string> = {
  task: "task",
  project: "project",
};

/** A short overall label for the queue's health, most severe state first. */
export function queueStatusLabel(counts: QueueCounts): string {
  if (counts.conflicts > 0) {
    return "Sync conflict";
  }
  if (counts.failed > 0) {
    return "Sync failed";
  }
  if (counts.pending > 0) {
    return "Pending sync";
  }
  return "All synced";
}

/** The count class used to colour the badge (`all` | `pending` | `conflict` | `failed`). */
export function queueStatusKind(counts: QueueCounts): "all" | "pending" | "conflict" | "failed" {
  if (counts.conflicts > 0) {
    return "conflict";
  }
  if (counts.failed > 0) {
    return "failed";
  }
  if (counts.pending > 0) {
    return "pending";
  }
  return "all";
}

/** A one-line summary of what is waiting, or that nothing is. */
export function queueSummaryText(counts: QueueCounts): string {
  if (counts.total === 0) {
    return "Nothing waiting to sync.";
  }
  const noun = counts.total === 1 ? "change" : "changes";
  return `${counts.total} ${noun} waiting to sync.`;
}

/** A human label for one queued operation, e.g. "Update task". */
export function operationLabel(operation: QueuedOperation): string {
  const verb = MUTATION_LABELS[operation.mutation] ?? operation.mutation;
  const entity = ENTITY_LABELS[operation.entityType] ?? operation.entityType;
  return `${verb} ${entity}`;
}

/** A short label for an operation's disposition. */
export function operationStatusLabel(status: OperationStatus): string {
  switch (status) {
    case "pending":
      return "Waiting";
    case "conflict":
      return "Conflict";
    case "failed":
      return "Failed";
    default:
      return status;
  }
}

/* -------------------------------------------------------------------------------------------------
 * Overall sync state (M7-05)
 * ------------------------------------------------------------------------------------------------- */

/** The overall sync state the panel's badge reports, most severe first. */
export type OverallSyncState = "up-to-date" | "syncing" | "offline" | "error" | "conflicts";

/** Everything the overall-state rule reads (all in `lib`/hooks — the component renders the result). */
export interface OverallSyncInput {
  counts: QueueCounts;
  /** `navigator.onLine` (or `true` where the environment does not expose it). */
  online: boolean;
  /** True while a sync/replay pass is in flight. */
  busy: boolean;
  /** True when the queue could not be read at all (its load state is `error`). */
  loadFailed: boolean;
}

/**
 * Derive the single overall sync state from the surfaces the panel already has.
 *
 * Precedence is deliberate (most important first): a queue that cannot be read is an `error`; an
 * unresolved `conflict` needs the user; a permanently `failed` operation is an `error`; being
 * `offline` explains why nothing is moving; outstanding work (or an in-flight pass) is `syncing`;
 * otherwise the client is `up-to-date`.
 */
export function overallSyncState(input: OverallSyncInput): OverallSyncState {
  if (input.loadFailed) {
    return "error";
  }
  if (input.counts.conflicts > 0) {
    return "conflicts";
  }
  if (input.counts.failed > 0) {
    return "error";
  }
  if (!input.online) {
    return "offline";
  }
  if (input.busy || input.counts.pending > 0) {
    return "syncing";
  }
  return "up-to-date";
}

const OVERALL_STATE_LABELS: Record<OverallSyncState, string> = {
  "up-to-date": "Up to date",
  syncing: "Syncing",
  offline: "Offline",
  error: "Sync error",
  conflicts: "Conflicts",
};

const OVERALL_STATE_DESCRIPTIONS: Record<OverallSyncState, string> = {
  "up-to-date": "All your changes are saved on the server.",
  syncing: "Your changes are being sent to the server.",
  offline: "You are offline. Changes are saved on this device and sent when you reconnect.",
  error: "Some changes could not be synced. See the details below.",
  conflicts: "Some changes conflict with the server and need your decision.",
};

/** The label for the overall state badge. */
export function overallSyncLabel(state: OverallSyncState): string {
  return OVERALL_STATE_LABELS[state];
}

/** A one-line description of the overall state. */
export function overallSyncDescription(state: OverallSyncState): string {
  return OVERALL_STATE_DESCRIPTIONS[state];
}

/** Format a queued-at instant as a readable local time, or `null` when unparseable. */
export function formatQueuedAt(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    date,
  );
}
