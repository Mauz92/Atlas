import type { ProviderSyncStatus } from "../api/client";
import type { LoadState } from "../hooks/useTaskView";
import { cursorHealthLabel, lastSyncText, providerLabel, stateLabel } from "../lib/syncStatus";
import { LoadError } from "./LoadError";

interface SyncStatusProps {
  providers: ProviderSyncStatus[];
  state: LoadState;
  /** A failure from loading the status (shown with a retry). */
  error: string | null;
  /** A failure from a manual "sync now" action. */
  actionError: string | null;
  /** The provider whose manual sync is in flight, if any. */
  busyProvider: string | null;
  onRetry: () => void;
  onSyncNow: (provider: string) => void;
}

/** One provider's sync state: connection, last success, any error, and a manual "Sync now". */
function SyncProvider({
  provider,
  busy,
  onSync,
}: {
  provider: ProviderSyncStatus;
  busy: boolean;
  onSync: () => void;
}) {
  const last = lastSyncText(provider);
  return (
    <li className="sync-provider">
      <header className="sync-provider-head">
        <h2>{providerLabel(provider.provider)}</h2>
        <span className={`pill${provider.state === "error" ? " pill-danger" : provider.state === "idle" ? " pill-success" : ""} sync-badge sync-badge-${provider.state}`} role="status">
          {stateLabel(provider.state)}
        </span>
        <button type="button" onClick={onSync} disabled={busy} aria-busy={busy}>
          {busy ? "Syncing…" : "Sync now"}
        </button>
      </header>
      <p className="muted sync-last">{last ?? "Never synced"}</p>
      <p className="muted">{provider.connected ? "Connected" : "Not connected"}</p>
      {provider.last_error ? (
        <p className="error" role="alert">
          {provider.last_error}
        </p>
      ) : null}
      {provider.calendars.length > 0 ? (
        <ul className="sync-calendars">
          {provider.calendars.map((calendar) => (
            <li key={calendar.calendar_id}>
              <span className="sync-calendar-id">{calendar.calendar_id}</span>
              <span className="muted">
                {stateLabel(calendar.state)} · {cursorHealthLabel(calendar.cursor_health)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No calendars synced yet.</p>
      )}
    </li>
  );
}

/**
 * The calendar sync-status surface (M5-08): per provider, the last successful sync, the derived
 * state and any error, with a retry affordance.
 *
 * Presentational only — it renders the `useSyncStatus` result and never calls the API itself
 * (business logic stays in the hook/`lib`). Loading, empty and error states are explicit, and the
 * manual-sync action is a focusable button that disables while in flight (AGENTS.md §6).
 */
export function SyncStatus({
  providers,
  state,
  error,
  actionError,
  busyProvider,
  onRetry,
  onSyncNow,
}: SyncStatusProps) {
  if (state === "loading") {
    return <p className="muted" role="status">Loading sync status…</p>;
  }
  if (state === "error") {
    return <LoadError message={error} onRetry={onRetry} />;
  }
  if (providers.length === 0) {
    return (
      <div className="empty-state">
        No calendar accounts are connected yet. Connect Google or Microsoft to see sync status.
      </div>
    );
  }
  return (
    <div className="sync-status">
      {actionError ? (
        <p className="error" role="alert">
          {actionError}
        </p>
      ) : null}
      <ul className="sync-providers">
        {providers.map((provider) => (
          <SyncProvider
            key={provider.provider}
            provider={provider}
            busy={busyProvider === provider.provider}
            onSync={() => onSyncNow(provider.provider)}
          />
        ))}
      </ul>
    </div>
  );
}
