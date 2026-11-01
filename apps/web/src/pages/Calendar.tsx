import { SyncStatus } from "../components/SyncStatus";
import { useSyncStatus } from "../hooks/useSyncStatus";

/**
 * The Calendar route's sync-status surface (M5-08).
 *
 * This shows the health of the calendar connection — last successful sync, state and errors per
 * provider — with a retry and a manual "Sync now". The day/week/month event views are a later
 * milestone (M5-05/M5-07); this page deliberately renders status only.
 */
export function CalendarPage() {
  const { providers, state, error, actionError, busyProvider, reload, syncNow } = useSyncStatus();

  return (
    <section className="page calendar-page">
      <h1>Calendar</h1>
      <p className="muted">
        Sync status for your connected calendars. Calendar views (day, week and month) are coming in
        a later milestone.
      </p>
      <SyncStatus
        providers={providers}
        state={state}
        error={error}
        actionError={actionError}
        busyProvider={busyProvider}
        onRetry={() => void reload()}
        onSyncNow={(provider) => void syncNow(provider)}
      />
    </section>
  );
}
