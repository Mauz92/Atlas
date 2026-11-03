import { useSyncStatus } from "../hooks/useSyncStatus";
import { SyncStatus } from "./SyncStatus";

/**
 * The Calendar section of Settings (M5-08; a page of its own until UX-08).
 *
 * This shows the health of the calendar connection: last successful sync, state and errors per
 * provider, with a retry and a manual "Sync now". The day/week/month event views are a later
 * milestone (M5-05/M5-07); this deliberately renders status only.
 */
export function CalendarSettings() {
  const { providers, state, error, actionError, busyProvider, reload, syncNow } = useSyncStatus();

  return (
    <SyncStatus
      providers={providers}
      state={state}
      error={error}
      actionError={actionError}
      busyProvider={busyProvider}
      onRetry={() => void reload()}
      onSyncNow={(provider) => void syncNow(provider)}
    />
  );
}
