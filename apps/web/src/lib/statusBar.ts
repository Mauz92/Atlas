/**
 * Wording for the status bar (UX-02, docs/UX_AUDIT.md §2 "VS Code status bar").
 *
 * The status bar is a summary only: the state itself comes from the offline queue
 * (`useOfflineQueue`), the browser's connectivity and the calendar sync status (`useSyncStatus`).
 * These functions turn that state into short labels, so the component only renders them.
 */
import type { ProviderSyncStatus } from "../api/client";
import type { IconName } from "../components/Icon";
import { overallSyncState, type QueueCounts } from "./queueStatus";
import { formatLastSync } from "./syncStatus";

export type StatusTone = "ok" | "neutral" | "warning" | "danger";

export interface StatusItem {
  icon: IconName;
  /** The short visible text. */
  text: string;
  /** A fuller accessible name for the link. */
  label: string;
  tone: StatusTone;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The sync item: connectivity plus what the offline queue holds, most important first. */
export function syncStatusItem(input: {
  counts: QueueCounts;
  online: boolean;
  /** The queue could not be read at all. */
  loadFailed: boolean;
}): StatusItem {
  const state = overallSyncState({ ...input, busy: false });
  const queued = input.counts.pending > 0 ? ` · ${input.counts.pending} queued` : "";
  switch (state) {
    case "conflicts": {
      const text = plural(input.counts.conflicts, "conflict");
      return { icon: "triangle-alert", text, label: `Sync: ${text}, needs your decision`, tone: "danger" };
    }
    case "error": {
      const text = input.loadFailed ? "Sync status unavailable" : plural(input.counts.failed, "failed change");
      return { icon: "triangle-alert", text, label: `Sync: ${text}`, tone: "danger" };
    }
    case "offline": {
      const text = `Offline${queued}`;
      return { icon: "cloud-off", text, label: `Sync: ${text}`, tone: "warning" };
    }
    case "syncing": {
      const text = `${input.counts.pending} queued`;
      return { icon: "refresh-cw", text, label: `Sync: ${text}`, tone: "neutral" };
    }
    default:
      return { icon: "cloud", text: "Synced", label: "Sync: all changes saved", tone: "ok" };
  }
}

/** The sync item inside the desktop shell: the engine's own state (SYNC-11c). */
export function shellSyncItem(
  sync: { state: string; pending: number; failed: number; conflicts: number; online: boolean } | null,
  phase: string,
): StatusItem {
  if (phase === "signed_out") return { icon: "triangle-alert", text: "Signed out", label: "Sync: signed out", tone: "danger" };
  if (phase === "update_required") return { icon: "triangle-alert", text: "Update required", label: "Sync: update required", tone: "danger" };
  if (!sync) return { icon: "refresh-cw", text: "Starting", label: "Sync: starting", tone: "neutral" };
  if (sync.state === "restore_confirmation") {
    return { icon: "triangle-alert", text: "Server restored: your decision", label: "Sync: stopped, the server was restored; your decision is needed", tone: "danger" };
  }
  return syncStatusItem({
    counts: { total: sync.pending + sync.failed + sync.conflicts, pending: sync.pending, failed: sync.failed, conflicts: sync.conflicts },
    online: sync.online,
    loadFailed: false,
  });
}

/** The latest successful calendar sync across providers, or `null` when none has run. */
function latestSync(providers: ProviderSyncStatus[]): string | null {
  let latest: string | null = null;
  for (const provider of providers) {
    const at = provider.last_success_at;
    if (at && !Number.isNaN(new Date(at).getTime()) && (!latest || new Date(at) > new Date(latest))) {
      latest = at;
    }
  }
  return latest;
}

/** A short "when": the time for today, else the date and time. */
function shortWhen(iso: string, now: Date): string {
  const date = new Date(iso);
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(date);
  }
  return formatLastSync(iso) ?? iso;
}

/**
 * The calendar item: not connected, failed, never synced or the last sync time. `null` while the
 * status is still loading (the bar shows nothing rather than a placeholder).
 */
export function calendarStatusItem(
  providers: ProviderSyncStatus[],
  state: "loading" | "ready" | "error",
  now: Date = new Date(),
): StatusItem | null {
  if (state === "loading") {
    return null;
  }
  if (state === "error") {
    return {
      icon: "calendar",
      text: "Calendar status unavailable",
      label: "Calendar: status unavailable",
      tone: "neutral",
    };
  }
  if (!providers.some((provider) => provider.connected)) {
    return { icon: "calendar", text: "Calendar not connected", label: "Calendar: not connected", tone: "neutral" };
  }
  if (providers.some((provider) => provider.needs_reauth)) {
    return { icon: "triangle-alert", text: "Calendar needs re-authorisation", label: "Calendar: needs re-authorisation", tone: "danger" };
  }
  if (providers.some((provider) => provider.state === "error")) {
    return { icon: "triangle-alert", text: "Calendar sync failed", label: "Calendar: sync failed", tone: "danger" };
  }
  const latest = latestSync(providers);
  if (!latest) {
    return { icon: "calendar", text: "Calendar not synced yet", label: "Calendar: not synced yet", tone: "neutral" };
  }
  const when = shortWhen(latest, now);
  return { icon: "calendar", text: `Calendar ${when}`, label: `Calendar: last synced ${when}`, tone: "neutral" };
}
