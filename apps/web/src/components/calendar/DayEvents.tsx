import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import type { CalendarEvent } from "../../api/client";
import { useCalendarEvents } from "../../hooks/useCalendarEvents";
import { colorVar, dayHeading, eventKey, segmentsByDay, segmentTimeText, startOfDayIn, addDaysKey } from "../../lib/calendar";
import { EventSheet } from "./EventSheet";

interface DayEventsProps {
  /** The first local day (`YYYY-MM-DD`) and how many consecutive days to list (1 for Today, 7 for Week). */
  firstDay: string;
  count: number;
  timeZone: string;
  /** Show a "No events" line for an empty day (Today) instead of leaving it out (Week). */
  showEmptyDays?: boolean;
}

/**
 * Calendar events for a few days, as a compact read-only list (Today's Events slot, the Week page's
 * events section). Events are visibly distinct from tasks: they sit in their own section, carry a
 * calendar-colour bar and a time, and are never checkable. A failure here is quiet on purpose - the
 * plan of tasks must not depend on the calendar.
 */
export function DayEvents({ firstDay, count, timeZone, showEmptyDays }: DayEventsProps) {
  const days = useMemo(() => Array.from({ length: count }, (_, index) => addDaysKey(firstDay, index)), [firstDay, count]);
  const start = useMemo(() => startOfDayIn(days[0], timeZone), [days, timeZone]);
  const end = useMemo(() => startOfDayIn(addDaysKey(days[days.length - 1], 1), timeZone), [days, timeZone]);
  const { events, sources, hasCalendars, state } = useCalendarEvents(start, end);
  const [selected, setSelected] = useState<CalendarEvent | null>(null);
  const segments = useMemo(() => segmentsByDay(events, days, timeZone), [events, days, timeZone]);

  if (state === "loading" && events.length === 0) return <p className="muted section-note" role="status">Loading events…</p>;
  if (state === "error") return <p className="muted section-note">Calendar events are unavailable right now.</p>;
  if (!hasCalendars) {
    return (
      <p className="muted section-note">
        No calendar is connected. <Link to="/settings/calendar">Connect one</Link> to see its events here.
      </p>
    );
  }
  const shown = days.filter((day) => showEmptyDays || (segments.get(day)?.length ?? 0) > 0);
  if (shown.length === 0) return <p className="muted section-note">No events.</p>;
  return (
    <>
      <ul className="day-events">
        {shown.map((day) => {
          const list = segments.get(day) ?? [];
          return (
            <li key={day}>
              {days.length > 1 ? <h3 className="day-events-day">{dayHeading(day, true)}</h3> : null}
              {list.length === 0 ? (
                <p className="muted section-note">No events.</p>
              ) : (
                <ul>
                  {list.map((segment) => (
                    <li key={`${eventKey(segment.event)}:${day}`}>
                      <button
                        type="button"
                        className="cal-agenda-event"
                        style={{ "--chip": colorVar(sources.get(segment.event.source_id)?.color) } as React.CSSProperties}
                        onClick={() => setSelected(segment.event)}
                      >
                        <span className="cal-agenda-time">{segmentTimeText(segment, timeZone)}</span>
                        <span className="cal-agenda-title">{segment.event.title || "(No title)"}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {selected ? (
        <EventSheet event={selected} source={sources.get(selected.source_id)} timeZone={timeZone} onClose={() => setSelected(null)} />
      ) : null}
    </>
  );
}
