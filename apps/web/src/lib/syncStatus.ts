import type { ProviderSyncStatus } from "../api/client";

/**
 * Presentation helpers for the calendar sync-status surface (M5-08).
 *
 * All the wording and formatting lives here (business logic out of components, AGENTS.md §6): the
 * component only renders what these functions return. The server owns the *state* — these functions
 * never reinterpret it, they only label it for a human.
 */

const PROVIDER_LABELS: Record<string, string> = {
  google: "Google Calendar",
  microsoft: "Microsoft Outlook",
  ics: "Calendar feeds (ICS)",
};

/** A friendly provider name; falls back to the raw value for an unknown provider. */
export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/** A short human label for a derived sync state. */
export function stateLabel(state: string): string {
  switch (state) {
    case "idle":
      return "Up to date";
    case "error":
      return "Sync failed";
    case "never_synced":
      return "Not synced yet";
    default:
      return state;
  }
}

/** A short human label for a calendar's cursor health. */
export function cursorHealthLabel(health: string): string {
  switch (health) {
    case "ok":
      return "Cursor healthy";
    case "missing":
      return "No cursor yet";
    case "error":
      return "Cursor stopped";
    default:
      return health;
  }
}

/**
 * Format a UTC instant as a local, human-readable timestamp, or `null` when there is none or the
 * value is unparseable (so the caller can render an explicit "never" instead of "Invalid Date").
 */
export function formatLastSync(iso: string | null): string | null {
  if (!iso) {
    return null;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    date,
  );
}

/** The "last successful sync" line for a provider, or `null` when it has never synced. */
export function lastSyncText(provider: ProviderSyncStatus): string | null {
  const formatted = formatLastSync(provider.last_success_at);
  return formatted ? `Last synced ${formatted}` : null;
}
