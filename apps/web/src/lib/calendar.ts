/**
 * Calendar view logic (M5-05, M5-07, ADR-0071): everything the Calendar page computes without
 * touching React or the network, so it can be tested in isolation.
 *
 * Time model: the server sends UTC instants plus the event's own IANA zone. A day is always a
 * *local calendar day in the viewer's zone* (the home zone setting, else the browser's), identified
 * by a `YYYY-MM-DD` key that never depends on the machine's zone. An all-day event is placed by its
 * `start_date`/`end_date` (end exclusive), so it shows on the same dates for every viewer. Tasks are
 * never turned into events here (AGENTS.md §9): this module only knows `CalendarEvent`.
 */
import type { CalendarEvent, CalendarProviderAccount, CalendarSource } from "../api/client";

export type CalendarView = "day" | "week" | "month" | "agenda";
export const CALENDAR_VIEWS: readonly CalendarView[] = ["day", "week", "month", "agenda"];

/** The eight calendar colours are the `--cal-1..8` design tokens (aliases of `--project-N`). */
export const CALENDAR_COLORS = ["1", "2", "3", "4", "5", "6", "7", "8"] as const;
export const COLOR_NAMES: Record<string, string> = {
  "1": "Blue",
  "2": "Teal",
  "3": "Green",
  "4": "Olive",
  "5": "Orange",
  "6": "Pink",
  "7": "Purple",
  "8": "Grey",
};

export function colorVar(color: string | null | undefined): string {
  return `var(--cal-${color && CALENDAR_COLORS.includes(color as never) ? color : "8"})`;
}

export function colorName(color: string | null | undefined): string {
  return (color && COLOR_NAMES[color]) || "Grey";
}

export const PROVIDER_NAMES: Record<string, string> = {
  google: "Google Calendar",
  microsoft: "Microsoft Outlook",
  ics: "Calendar feed",
};

/** Short, plain-language help for each setup problem code the server reports. */
export function setupProblemText(code: string): string {
  switch (code) {
    case "client_id_missing":
      return "The client ID is not set on the server.";
    case "client_secret_missing":
      return "The client secret is not set on the server.";
    case "public_base_url_not_https":
      return "PUBLIC_BASE_URL must start with https:// (or be a localhost address while developing).";
    case "public_base_url_is_local":
      return "PUBLIC_BASE_URL points at this computer; set the address you open Atlas with.";
    default:
      return "The server is not set up for this provider.";
  }
}

/** The banner text for the `?calendar_result=` code the OAuth callback redirects with. */
export function connectResultMessage(result: string, provider: string): { ok: boolean; text: string } {
  const name = PROVIDER_NAMES[provider] ?? "The calendar";
  switch (result) {
    case "connected":
      return { ok: true, text: `${name} is connected. Choose which calendars to show below.` };
    case "discovery_failed":
      return {
        ok: false,
        text: `${name} is connected, but its calendar list could not be read yet. Use "Sync now" to retry.`,
      };
    case "access_denied":
    case "denied":
      return { ok: false, text: `Connection cancelled. Nothing was changed.` };
    case "insufficient_scope":
      return { ok: false, text: `${name} was not given permission to read your calendars. Connect again and leave the calendar permission ticked.` };
    case "no_refresh_token":
      return { ok: false, text: `${name} did not allow lasting access. Remove Atlas in the provider's account permissions and connect again.` };
    case "state_expired":
    case "state_used":
    case "invalid_state":
      return { ok: false, text: "That sign-in link was already used or has expired. Start the connection again." };
    case "provider_unreachable":
      return { ok: false, text: `${name} could not be reached. Try again in a moment.` };
    default:
      return { ok: false, text: `${name} could not be connected (${result}). See the troubleshooting table in docs/CALENDAR_SYNC.md.` };
  }
}

/* ------------------------------------------------------------------------------------------------
 * Days and zones
 * ---------------------------------------------------------------------------------------------- */

const DAY_MS = 86_400_000;

export function parseKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function keyOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDaysKey(key: string, days: number): string {
  return keyOf(new Date(parseKey(key).getTime() + days * DAY_MS));
}

export function addMonthsKey(key: string, months: number): string {
  const d = parseKey(key);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), last));
  return keyOf(target);
}

/** Monday of the week containing `key`. */
export function weekStartKey(key: string): string {
  const weekday = (parseKey(key).getUTCDay() + 6) % 7;
  return addDaysKey(key, -weekday);
}

export function monthStartKey(key: string): string {
  return `${key.slice(0, 7)}-01`;
}

/** The local calendar day an instant falls on in `timeZone`. */
export function dayKeyIn(instant: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(typeof instant === "string" ? new Date(instant) : instant);
}

function offsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The UTC instant at which local day `key` begins in `timeZone` (DST-safe). */
export function startOfDayIn(key: string, timeZone: string): Date {
  const guess = parseKey(key).getTime();
  let result = guess - offsetMs(guess, timeZone);
  result = guess - offsetMs(result, timeZone);
  return new Date(result);
}

export interface Range {
  /** Inclusive start instant. */
  start: Date;
  /** Exclusive end instant. */
  end: Date;
  /** Local day keys the range covers, in order. */
  days: string[];
}

function rangeOfDays(first: string, count: number, timeZone: string): Range {
  const days = Array.from({ length: count }, (_, index) => addDaysKey(first, index));
  return { start: startOfDayIn(first, timeZone), end: startOfDayIn(addDaysKey(first, count), timeZone), days };
}

/** The days a view shows for `anchor`, and the instants to request from the server. */
export function viewRange(view: CalendarView, anchor: string, timeZone: string): Range {
  switch (view) {
    case "day":
      return rangeOfDays(anchor, 1, timeZone);
    case "week":
      return rangeOfDays(weekStartKey(anchor), 7, timeZone);
    case "month": {
      const first = weekStartKey(monthStartKey(anchor));
      const monthEnd = addDaysKey(addMonthsKey(monthStartKey(anchor), 1), -1);
      const last = addDaysKey(weekStartKey(monthEnd), 6);
      const count = Math.round((parseKey(last).getTime() - parseKey(first).getTime()) / DAY_MS) + 1;
      return rangeOfDays(first, count, timeZone);
    }
    case "agenda":
      return rangeOfDays(anchor, 30, timeZone);
  }
}

export function stepAnchor(view: CalendarView, anchor: string, direction: 1 | -1): string {
  switch (view) {
    case "day":
      return addDaysKey(anchor, direction);
    case "week":
      return addDaysKey(anchor, 7 * direction);
    case "month":
      return addMonthsKey(monthStartKey(anchor), direction);
    case "agenda":
      return addDaysKey(anchor, 30 * direction);
  }
}

export function rangeTitle(view: CalendarView, anchor: string, range: Range): string {
  const fmt = (key: string, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(undefined, { timeZone: "UTC", ...options }).format(parseKey(key));
  if (view === "day") return fmt(anchor, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  if (view === "month") return fmt(anchor, { month: "long", year: "numeric" });
  const first = range.days[0];
  const last = range.days[range.days.length - 1];
  return `${fmt(first, { month: "short", day: "numeric" })} – ${fmt(last, { month: "short", day: "numeric", year: "numeric" })}`;
}

export function dayHeading(key: string, long = false): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    weekday: long ? "long" : "short",
    month: "short",
    day: "numeric",
  }).format(parseKey(key));
}

/* ------------------------------------------------------------------------------------------------
 * Events on days
 * ---------------------------------------------------------------------------------------------- */

export interface Segment {
  event: CalendarEvent;
  day: string;
  allDay: boolean;
  /** Minutes from local midnight, clipped to the day (timed segments only). */
  startMin: number;
  endMin: number;
  /** The event began on an earlier day / continues on a later one. */
  continuesBefore: boolean;
  continuesAfter: boolean;
}

export function eventKey(event: CalendarEvent): string {
  return `${event.id}:${event.occurrence ?? ""}`;
}

function minutesIntoDay(instant: Date, dayStart: Date): number {
  return Math.round((instant.getTime() - dayStart.getTime()) / 60_000);
}

/** Split events into per-day segments for the visible `days` in the viewer's zone. */
export function segmentsByDay(events: CalendarEvent[], days: string[], timeZone: string): Map<string, Segment[]> {
  const out = new Map<string, Segment[]>(days.map((day) => [day, []]));
  for (const event of events) {
    if (event.is_all_day && event.start_date && event.end_date) {
      let day = event.start_date;
      while (day < event.end_date) {
        out.get(day)?.push({
          event, day, allDay: true, startMin: 0, endMin: 1440,
          continuesBefore: day > event.start_date,
          continuesAfter: addDaysKey(day, 1) < event.end_date,
        });
        day = addDaysKey(day, 1);
      }
      continue;
    }
    const start = new Date(event.start);
    const end = new Date(event.end);
    const firstDay = dayKeyIn(start, timeZone);
    const lastInstant = end.getTime() > start.getTime() ? new Date(end.getTime() - 1) : start;
    const lastDay = dayKeyIn(lastInstant, timeZone);
    for (const day of days) {
      if (day < firstDay || day > lastDay) continue;
      const dayStart = startOfDayIn(day, timeZone);
      const dayEnd = startOfDayIn(addDaysKey(day, 1), timeZone);
      out.get(day)?.push({
        event, day, allDay: false,
        startMin: Math.max(0, minutesIntoDay(start, dayStart)),
        endMin: Math.min(minutesIntoDay(dayEnd, dayStart), Math.max(minutesIntoDay(end, dayStart), minutesIntoDay(start, dayStart) + 15)),
        continuesBefore: day > firstDay,
        continuesAfter: day < lastDay,
      });
    }
  }
  for (const list of out.values()) {
    list.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startMin - b.startMin || a.endMin - b.endMin || (a.event.title ?? "").localeCompare(b.event.title ?? ""));
  }
  return out;
}

export interface Placed {
  segment: Segment;
  column: number;
  columns: number;
}

/** Side-by-side columns for overlapping timed segments (each cluster shares one column count). */
export function layoutOverlaps(segments: Segment[]): Placed[] {
  const timed = segments.filter((segment) => !segment.allDay).sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  const placed: Placed[] = [];
  let cluster: Placed[] = [];
  let clusterEnd = -1;
  let columnEnds: number[] = [];
  const flush = () => {
    for (const item of cluster) item.columns = columnEnds.length;
    placed.push(...cluster);
    cluster = [];
    columnEnds = [];
  };
  for (const segment of timed) {
    if (segment.startMin >= clusterEnd && cluster.length > 0) flush();
    let column = columnEnds.findIndex((end) => end <= segment.startMin);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(segment.endMin);
    } else {
      columnEnds[column] = segment.endMin;
    }
    cluster.push({ segment, column, columns: 1 });
    clusterEnd = Math.max(clusterEnd, segment.endMin);
  }
  flush();
  return placed;
}

/* ------------------------------------------------------------------------------------------------
 * Formatting
 * ---------------------------------------------------------------------------------------------- */

export function formatTime(instant: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, { timeZone, hour: "numeric", minute: "2-digit" }).format(
    typeof instant === "string" ? new Date(instant) : instant,
  );
}

/** "9:00 AM – 10:00 AM", "All day", or "Continues" for a middle day of a multi-day event. */
export function segmentTimeText(segment: Segment, timeZone: string): string {
  if (segment.allDay) return "All day";
  const start = segment.continuesBefore ? "" : formatTime(segment.event.start, timeZone);
  const end = segment.continuesAfter ? "" : formatTime(segment.event.end, timeZone);
  if (!start && !end) return "All day";
  if (!start) return `Until ${end}`;
  if (!end) return `From ${start}`;
  return segment.event.start === segment.event.end ? start : `${start} – ${end}`;
}

/** The event's own zone, when it differs from the viewer's (timed events only). */
export function otherZoneNote(event: CalendarEvent, viewerZone: string): string | null {
  if (event.is_all_day || event.time_zone === viewerZone) return null;
  const sameOffset =
    new Intl.DateTimeFormat("en-US", { timeZone: event.time_zone, timeZoneName: "short" }).format(new Date(event.start)) ===
    new Intl.DateTimeFormat("en-US", { timeZone: viewerZone, timeZoneName: "short" }).format(new Date(event.start));
  if (sameOffset) return null;
  return `${formatTime(event.start, event.time_zone)} in ${event.time_zone.replace(/_/g, " ")}`;
}

/** A calendar the viewer can see in the view: selected sources by id. */
export function sourceIndex(sources: CalendarSource[]): Map<string, CalendarSource> {
  return new Map(sources.map((source) => [source.id, source]));
}

export const DAY_START_HOUR = 0;

/** The card's state, derived from what the server reports (never guessed in the UI). */
export type CardState = "not_configured" | "not_connected" | "connected" | "needs_reauth" | "error";

export function cardState(provider: CalendarProviderAccount): CardState {
  if (!provider.configured) return "not_configured";
  if (!provider.connected) return "not_connected";
  if (provider.needs_reauth) return "needs_reauth";
  return provider.calendars.some((calendar) => calendar.state === "error") ? "error" : "connected";
}
