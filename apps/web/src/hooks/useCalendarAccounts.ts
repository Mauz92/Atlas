import { useCallback, useEffect, useState } from "react";

import {
  ApiError,
  calendarApi,
  type CalendarFeedPreview,
  type CalendarProviderAccount,
  type CalendarSource,
} from "../api/client";
import { PROVIDER_NAMES } from "../lib/calendar";
import type { LoadState } from "./useTaskView";

/** Fired after any calendar change so the status bar (a separate hook instance) re-reads the status. */
export const CALENDAR_CHANGED_EVENT = "atlas:calendar-changed";

export interface CalendarAccountsResult {
  providers: CalendarProviderAccount[];
  state: LoadState;
  error: string | null;
  /** The last action's failure (connect, sync, toggle ...), shown where the action was started. */
  actionError: string | null;
  /** A provider name, a source id or "feed" while that action is in flight. */
  busy: string | null;
  reload: () => Promise<void>;
  connect: (provider: "google" | "microsoft") => Promise<void>;
  disconnect: (provider: "google" | "microsoft") => Promise<string | null>;
  syncNow: (provider: string) => Promise<void>;
  setSelected: (id: string, selected: boolean) => Promise<void>;
  setColor: (id: string, color: string) => Promise<void>;
  previewFeed: (url: string) => Promise<CalendarFeedPreview | null>;
  addFeed: (feed: { url: string; name: string; color?: string }) => Promise<boolean>;
  removeFeed: (id: string) => Promise<void>;
  previewImport: (content: string) => Promise<CalendarFeedPreview | null>;
  addImport: (file: { content: string; name: string; color?: string }) => Promise<boolean>;
  replaceImport: (id: string, content: string) => Promise<void>;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError || error instanceof Error ? error.message : fallback;
}

/**
 * The Settings → Calendar data and actions (M5-05). The server owns every rule (scopes, SSRF,
 * secrets); this hook only relays calls and keeps the last result on screen. A failed action is
 * reported in `actionError` and never hides the last-known accounts.
 */
export function useCalendarAccounts(): CalendarAccountsResult {
  const [providers, setProviders] = useState<CalendarProviderAccount[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setProviders((await calendarApi.accounts()).providers);
      setError(null);
      setState("ready");
    } catch (err) {
      setError(messageOf(err, "Could not load your calendars"));
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const reload = useCallback(async () => {
    setState("loading");
    await load();
  }, [load]);

  const run = useCallback(
    async (key: string, action: () => Promise<void>, failure: string) => {
      setActionError(null);
      setBusy(key);
      try {
        await action();
      } catch (err) {
        setActionError(messageOf(err, failure));
      } finally {
        setBusy(null);
        window.dispatchEvent(new Event(CALENDAR_CHANGED_EVENT));
      }
    },
    [],
  );

  const connect = useCallback(
    (provider: "google" | "microsoft") =>
      run(provider, async () => {
        const { authorization_url } = await calendarApi.connect(provider);
        window.location.assign(authorization_url);
      }, `Could not start the ${PROVIDER_NAMES[provider]} connection.`),
    [run],
  );

  const disconnect = useCallback(
    async (provider: "google" | "microsoft") => {
      let summary: string | null = null;
      await run(provider, async () => {
        const result = await calendarApi.disconnect(provider);
        summary = `${PROVIDER_NAMES[provider]} disconnected. ${result.events_removed} stored events were removed from Atlas${
          result.revoked_at_provider ? " and access was revoked at the provider" : "; remove Atlas in the provider's account permissions to finish revoking access"
        }.`;
        await load();
      }, `Could not disconnect ${PROVIDER_NAMES[provider]}.`);
      return summary;
    },
    [run, load],
  );

  const syncNow = useCallback(
    (provider: string) =>
      run(provider, async () => {
        try {
          await calendarApi.syncProvider(provider as "google" | "microsoft" | "ics");
        } finally {
          await load();
        }
      }, `Could not sync ${PROVIDER_NAMES[provider] ?? provider}.`),
    [run, load],
  );

  /** Show the choice at once; the server answer (or a reload after a failure) settles it. */
  const optimistic = useCallback((id: string, patch: Partial<CalendarSource>) => {
    setProviders((current) =>
      current.map((provider) => ({
        ...provider,
        calendars: provider.calendars.map((calendar) => (calendar.id === id ? { ...calendar, ...patch } : calendar)),
      })),
    );
  }, []);

  const setSelected = useCallback(
    (id: string, selected: boolean) => {
      optimistic(id, { selected });
      return run(id, async () => {
        try {
          await calendarApi.updateSource(id, { selected });
        } finally {
          await load();
        }
      }, "Could not change that calendar.");
    },
    [run, load, optimistic],
  );

  const setColor = useCallback(
    (id: string, color: string) => {
      optimistic(id, { color });
      return run(id, async () => {
        try {
          await calendarApi.updateSource(id, { color });
        } finally {
          await load();
        }
      }, "Could not change the colour.");
    },
    [run, load, optimistic],
  );

  const previewFeed = useCallback(async (url: string) => {
    setActionError(null);
    setBusy("feed");
    try {
      return await calendarApi.previewFeed(url);
    } catch (err) {
      setActionError(messageOf(err, "Could not read that feed."));
      return null;
    } finally {
      setBusy(null);
    }
  }, []);

  const addFeed = useCallback(
    async (feed: { url: string; name: string; color?: string }) => {
      let ok = false;
      await run("feed", async () => {
        await calendarApi.addFeed(feed);
        await load();
        ok = true;
      }, "Could not add that feed.");
      return ok;
    },
    [run, load],
  );

  const removeFeed = useCallback(
    (id: string) =>
      run(id, async () => {
        await calendarApi.removeFeed(id);
        await load();
      }, "Could not remove that feed."),
    [run, load],
  );

  const previewImport = useCallback(async (content: string) => {
    setActionError(null);
    setBusy("feed");
    try {
      return await calendarApi.previewImport(content);
    } catch (err) {
      setActionError(messageOf(err, "Could not read that file."));
      return null;
    } finally {
      setBusy(null);
    }
  }, []);

  const addImport = useCallback(
    async (file: { content: string; name: string; color?: string }) => {
      let ok = false;
      await run("feed", async () => {
        await calendarApi.addImport(file);
        await load();
        ok = true;
      }, "Could not import that file.");
      return ok;
    },
    [run, load],
  );

  const replaceImport = useCallback(
    (id: string, content: string) =>
      run(id, async () => {
        await calendarApi.replaceImport(id, content);
        await load();
      }, "Could not replace the file."),
    [run, load],
  );

  return {
    providers, state, error, actionError, busy, reload, connect, disconnect, syncNow,
    setSelected, setColor, previewFeed, addFeed, removeFeed, previewImport, addImport, replaceImport,
  };
}
