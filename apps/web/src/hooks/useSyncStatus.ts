import { useCallback, useEffect, useState } from "react";

import { calendarApi, type CredentialProvider, type ProviderSyncStatus } from "../api/client";
import { providerLabel } from "../lib/syncStatus";
import type { LoadState } from "./useTaskView";

export interface SyncStatusResult {
  /** One entry per connected provider (or provider with a stored cursor). */
  providers: ProviderSyncStatus[];
  state: LoadState;
  /** A failure from loading the status. */
  error: string | null;
  /** A failure from a manual "sync now" action. */
  actionError: string | null;
  /** The provider whose manual sync is in flight, if any. */
  busyProvider: string | null;
  reload: () => Promise<void>;
  syncNow: (provider: string) => Promise<void>;
}

/**
 * Load the calendar sync status and trigger a manual sync (M5-08).
 *
 * The status is derived server-side from the sync cursors, so the hook only fetches and relays it;
 * the wording/formatting lives in `lib/syncStatus.ts` and the component renders state. "Sync now"
 * calls the idempotent trigger and reloads the status so the result is visible; a failed trigger is
 * surfaced (never silently ignored) while the last-known status stays on screen.
 */
export function useSyncStatus(): SyncStatusResult {
  const [providers, setProviders] = useState<ProviderSyncStatus[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyProvider, setBusyProvider] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const status = await calendarApi.syncStatus();
      setProviders(status.providers);
      setError(null);
      setState("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load calendar sync status");
      setState("error");
    }
  }, []);

  const reload = useCallback(async () => {
    setState("loading");
    await load();
  }, [load]);

  const syncNow = useCallback(
    async (provider: string) => {
      setActionError(null);
      setBusyProvider(provider);
      try {
        await calendarApi.syncProvider(provider as CredentialProvider);
        await load();
      } catch (err) {
        setActionError(
          err instanceof Error
            ? `Could not sync ${providerLabel(provider)}: ${err.message}`
            : `Could not sync ${providerLabel(provider)}.`,
        );
      } finally {
        setBusyProvider(null);
      }
    },
    [load],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return { providers, state, error, actionError, busyProvider, reload, syncNow };
}
