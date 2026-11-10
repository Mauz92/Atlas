import { useCallback, useEffect, useMemo, useState } from "react";

import { calendarApi, type CalendarEvent, type CalendarSource } from "../api/client";
import { sourceIndex } from "../lib/calendar";
import type { LoadState } from "./useTaskView";

export interface CalendarEventsResult {
  events: CalendarEvent[];
  /** The caller's calendars by id (colour, name, read-only), for drawing events. */
  sources: Map<string, CalendarSource>;
  /** Whether any calendar is connected or any feed added (drives the empty states). */
  hasCalendars: boolean;
  state: LoadState;
  error: string | null;
  truncated: boolean;
  reload: () => Promise<void>;
}

/**
 * Events for `[start, end)` plus the calendars they belong to. `start`/`end` must be memoised by the
 * caller (they are effect dependencies). Read-only; a stale response for a previous range is dropped.
 */
export function useCalendarEvents(start: Date, end: Date): CalendarEventsResult {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [sourceList, setSourceList] = useState<CalendarSource[]>([]);
  const [hasCalendars, setHasCalendars] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    void (async () => {
      try {
        const [accounts, list] = await Promise.all([calendarApi.accounts(), calendarApi.events(start, end)]);
        if (cancelled) return;
        const calendars = accounts.providers.flatMap((provider) => provider.calendars);
        setSourceList(calendars);
        setHasCalendars(calendars.length > 0);
        setEvents(list.events);
        setTruncated(list.truncated);
        setError(null);
        setState("ready");
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Could not load calendar events");
        setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [start, end, nonce]);

  const reload = useCallback(async () => setNonce((n) => n + 1), []);
  const sources = useMemo(() => sourceIndex(sourceList), [sourceList]);
  return { events, sources, hasCalendars, state, error, truncated, reload };
}
