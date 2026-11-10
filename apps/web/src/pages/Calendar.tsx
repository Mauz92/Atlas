import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import type { CalendarEvent, CalendarSource } from "../api/client";
import { EventSheet } from "../components/calendar/EventSheet";
import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icon";
import { LoadError } from "../components/LoadError";
import { Skeleton } from "../components/Skeleton";
import { useCalendarEvents } from "../hooks/useCalendarEvents";
import { useMediaQuery } from "../hooks/useMediaQuery";
import {
  CALENDAR_VIEWS,
  colorVar,
  dayHeading,
  dayKeyIn,
  eventKey,
  layoutOverlaps,
  otherZoneNote,
  rangeTitle,
  segmentsByDay,
  segmentTimeText,
  stepAnchor,
  viewRange,
  type CalendarView,
  type Segment,
} from "../lib/calendar";
import { PHONE_QUERY } from "../lib/phone";
import { settingsPath } from "../lib/settingsSections";
import { viewerTimeZone } from "../lib/tasks";

const VIEW_LABEL: Record<CalendarView, string> = { day: "Day", week: "Week", month: "Month", agenda: "Agenda" };
const VIEW_KEY = "atlas-calendar-view";

function storedView(phone: boolean): CalendarView {
  try {
    const value = localStorage.getItem(VIEW_KEY);
    if (CALENDAR_VIEWS.includes(value as CalendarView)) return value as CalendarView;
  } catch {
    // storage unavailable: fall through to the default
  }
  return phone ? "agenda" : "week";
}

interface ViewProps {
  days: string[];
  anchor: string;
  today: string;
  timeZone: string;
  segments: Map<string, Segment[]>;
  sources: Map<string, CalendarSource>;
  onOpen: (event: CalendarEvent) => void;
  onPickDay: (day: string) => void;
}

function EventChip({ segment, timeZone, sources, onOpen, compact }: { segment: Segment } & Pick<ViewProps, "timeZone" | "sources" | "onOpen"> & { compact?: boolean }) {
  const source = sources.get(segment.event.source_id);
  return (
    <button
      type="button"
      className={`cal-chip${compact ? " is-compact" : ""}${segment.event.status === "tentative" ? " is-tentative" : ""}`}
      style={{ "--chip": colorVar(source?.color) } as React.CSSProperties}
      onClick={() => onOpen(segment.event)}
    >
      {!segment.allDay && !compact ? <span className="cal-chip-time">{segmentTimeText(segment, timeZone)} </span> : null}
      <span className="cal-chip-title">{segment.event.title || "(No title)"}</span>
      <span className="sr-only">{`, ${segmentTimeText(segment, timeZone)}${source ? `, ${source.name}` : ""}`}</span>
    </button>
  );
}

/** One list of days with their events: the phone's primary layout and the Agenda view. */
function AgendaList({ days, today, timeZone, segments, sources, onOpen, showEmptyDays }: ViewProps & { showEmptyDays: boolean }) {
  const shown = days.filter((day) => showEmptyDays || (segments.get(day)?.length ?? 0) > 0 || day === today);
  return (
    <ol className="cal-agenda">
      {shown.map((day) => {
        const list = segments.get(day) ?? [];
        return (
          <li key={day} className={`cal-agenda-day${day === today ? " is-today" : ""}`}>
            <h2>
              {dayHeading(day, true)}
              {day === today ? <span className="pill pill-success">Today</span> : null}
            </h2>
            {list.length === 0 ? (
              <p className="muted">No events.</p>
            ) : (
              <ul>
                {list.map((segment) => {
                  const source = sources.get(segment.event.source_id);
                  const zone = otherZoneNote(segment.event, timeZone);
                  return (
                    <li key={`${eventKey(segment.event)}:${day}`}>
                      <button
                        type="button"
                        className="cal-agenda-event"
                        style={{ "--chip": colorVar(source?.color) } as React.CSSProperties}
                        onClick={() => onOpen(segment.event)}
                      >
                        <span className="cal-agenda-time">{segmentTimeText(segment, timeZone)}</span>
                        <span className="cal-agenda-main">
                          <span className="cal-agenda-title">{segment.event.title || "(No title)"}</span>
                          <span className="muted">
                            {[source?.name, segment.event.location, zone].filter(Boolean).join(" · ")}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/** Day and week on a wide screen: an all-day row above a 24-hour grid, overlaps side by side. */
function TimeGrid({ days, today, timeZone, segments, sources, onOpen, onPickDay }: ViewProps) {
  const nowMin = (() => {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
    return Number(parts.find((p) => p.type === "hour")?.value) * 60 + Number(parts.find((p) => p.type === "minute")?.value);
  })();
  return (
    <div className="cal-grid" style={{ "--cols": days.length } as React.CSSProperties}>
      <div className="cal-grid-head">
        <span className="cal-gutter" />
        {days.map((day) => (
          <button key={day} type="button" className={`cal-colhead${day === today ? " is-today" : ""}`} aria-current={day === today ? "date" : undefined} onClick={() => onPickDay(day)}>
            {dayHeading(day)}
          </button>
        ))}
      </div>
      <div className="cal-allday" role="group" aria-label="All-day events">
        <span className="cal-gutter">All day</span>
        {days.map((day) => (
          <div key={day} className="cal-allday-cell">
            {(segments.get(day) ?? []).filter((s) => s.allDay).map((segment) => (
              <EventChip key={`${eventKey(segment.event)}:${day}`} segment={segment} timeZone={timeZone} sources={sources} onOpen={onOpen} compact />
            ))}
          </div>
        ))}
      </div>
      <div className="cal-body">
        <div className="cal-gutter cal-hours" aria-hidden="true">
          {HOURS.map((hour) => (
            <span key={hour} className="cal-hour-label">{new Intl.DateTimeFormat(undefined, { hour: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 1, hour)))}</span>
          ))}
        </div>
        {days.map((day) => (
          <div key={day} className={`cal-col${day === today ? " is-today" : ""}`} role="group" aria-label={dayHeading(day, true)}>
            {HOURS.map((hour) => <span key={hour} className="cal-hour-line" />)}
            {layoutOverlaps(segments.get(day) ?? []).map(({ segment, column, columns }) => {
              const source = sources.get(segment.event.source_id);
              return (
                <button
                  key={`${eventKey(segment.event)}:${day}`}
                  type="button"
                  className="cal-block"
                  style={{
                    "--chip": colorVar(source?.color),
                    top: `calc(var(--cal-hour) * ${segment.startMin / 60})`,
                    height: `calc(var(--cal-hour) * ${Math.max(segment.endMin - segment.startMin, 20) / 60})`,
                    left: `${(column / columns) * 100}%`,
                    width: `${100 / columns}%`,
                  } as React.CSSProperties}
                  onClick={() => onOpen(segment.event)}
                >
                  <span className="cal-block-time">{segmentTimeText(segment, timeZone)} </span>
                  <span className="cal-block-title">{segment.event.title || "(No title)"}</span>
                  <span className="sr-only">{source ? `, ${source.name}` : ""}</span>
                </button>
              );
            })}
            {day === today ? <span className="cal-now" style={{ top: `calc(var(--cal-hour) * ${nowMin / 60})` }} aria-hidden="true" /> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Month: a grid of days. Wide screens list up to three events per cell; phones show dots and a day list. */
function MonthGrid({ days, anchor, today, timeZone, segments, sources, onOpen, onPickDay, phone }: ViewProps & { phone: boolean }) {
  const month = anchor.slice(0, 7);
  return (
    <div className="cal-month">
      <div className="cal-month-head" aria-hidden="true">
        {days.slice(0, 7).map((day) => <span key={day}>{dayHeading(day).split(",")[0]}</span>)}
      </div>
      <div className="cal-month-grid" role="group" aria-label="Month">
        {days.map((day) => {
          const list = segments.get(day) ?? [];
          const outside = !day.startsWith(month);
          return (
            <div key={day} className={`cal-cell${day === today ? " is-today" : ""}${outside ? " is-outside" : ""}${day === anchor ? " is-anchor" : ""}`}>
              <button type="button" className="cal-cell-day" onClick={() => onPickDay(day)} aria-label={`${dayHeading(day, true)}${list.length ? `, ${list.length} events` : ""}`} aria-current={day === today ? "date" : undefined}>
                {Number(day.slice(8))}
              </button>
              {phone ? (
                <span className="cal-dots" aria-hidden="true">
                  {list.slice(0, 3).map((segment) => (
                    <span key={eventKey(segment.event)} className="cal-dot" style={{ background: colorVar(sources.get(segment.event.source_id)?.color) }} />
                  ))}
                </span>
              ) : (
                <>
                  {list.slice(0, 3).map((segment) => (
                    <EventChip key={`${eventKey(segment.event)}:${day}`} segment={segment} timeZone={timeZone} sources={sources} onOpen={onOpen} compact />
                  ))}
                  {list.length > 3 ? (
                    <button type="button" className="cal-more" onClick={() => onPickDay(day)}>+{list.length - 3} more</button>
                  ) : null}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The Calendar page (M5-07, ADR-0071): Day, Week, Month and Agenda views of the events from every
 * selected calendar, read-only. Instants are shown in the viewer's zone (the event's own zone is on
 * the detail); all-day events keep their dates; overlapping events sit side by side. On a phone the
 * Agenda is the default and Week is an agenda of the week; keyboard: ←/→ move, `t` today, `d`/`w`/`m`/`a`
 * switch views. Task deadlines are never shown here as events (they stay on Today, Upcoming and Week).
 */
export function CalendarPage() {
  const phone = useMediaQuery(PHONE_QUERY, false);
  const timeZone = useMemo(() => viewerTimeZone() ?? "UTC", []);
  const today = dayKeyIn(new Date(), timeZone);
  const [view, setView] = useState<CalendarView>(() => storedView(phone));
  const [anchor, setAnchor] = useState(today);
  const [selected, setSelected] = useState<CalendarEvent | null>(null);
  const navigate = useNavigate();

  const range = useMemo(() => viewRange(view, anchor, timeZone), [view, anchor, timeZone]);
  const { events, sources, hasCalendars, state, error, truncated, reload } = useCalendarEvents(range.start, range.end);
  const segments = useMemo(() => segmentsByDay(events, range.days, timeZone), [events, range.days, timeZone]);

  const choose = useCallback((next: CalendarView) => {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // the choice still applies for this page view
    }
  }, []);
  const step = useCallback((direction: 1 | -1) => setAnchor((current) => stepAnchor(view, current, direction)), [view]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.ctrlKey || event.metaKey || event.altKey || selected) return;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      const map: Record<string, () => void> = {
        ArrowLeft: () => step(-1),
        ArrowRight: () => step(1),
        t: () => setAnchor(today),
        d: () => choose("day"),
        w: () => choose("week"),
        m: () => choose("month"),
        a: () => choose("agenda"),
      };
      const handler = map[event.key];
      if (handler) {
        event.preventDefault();
        handler();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [step, choose, today, selected]);

  const props: ViewProps = {
    days: range.days, anchor, today, timeZone, segments, sources,
    onOpen: setSelected,
    onPickDay: (day) => {
      setAnchor(day);
      if (view === "month" && !phone) choose("day");
    },
  };

  const body = (() => {
    if (view === "agenda") return <AgendaList {...props} showEmptyDays={false} />;
    if (view === "month") {
      return (
        <>
          <MonthGrid {...props} phone={phone} />
          {phone ? <AgendaList {...props} days={[anchor]} showEmptyDays /> : null}
        </>
      );
    }
    if (phone) return <AgendaList {...props} showEmptyDays />;
    return <TimeGrid {...props} />;
  })();

  const total = events.length;
  return (
    <section className="cal-page" aria-labelledby="cal-title">
      <header className="cal-toolbar">
        <h1 id="cal-title">Calendar</h1>
        <div className="cal-nav" role="group" aria-label="Move through time">
          <button type="button" className="icon-button" aria-label={`Previous ${view === "agenda" ? "30 days" : view}`} onClick={() => step(-1)}>
            <Icon name="chevron-left" size={20} />
          </button>
          <button type="button" onClick={() => setAnchor(today)} disabled={range.days.includes(today) && anchor === today}>Today</button>
          <button type="button" className="icon-button" aria-label={`Next ${view === "agenda" ? "30 days" : view}`} onClick={() => step(1)}>
            <Icon name="chevron-right" size={20} />
          </button>
        </div>
        <p className="cal-range" aria-live="polite">{rangeTitle(view, anchor, range)}</p>
        <div className="cal-views" role="group" aria-label="View">
          {CALENDAR_VIEWS.map((option) => (
            <button key={option} type="button" aria-pressed={view === option} className={view === option ? "is-active" : ""} onClick={() => choose(option)}>
              {VIEW_LABEL[option]}
            </button>
          ))}
        </div>
      </header>

      {state === "loading" && events.length === 0 ? <Skeleton label="Loading calendar" rows={5} groups={2} /> : null}
      {state === "error" ? <LoadError message={error} onRetry={() => void reload()} /> : null}
      {state === "ready" && !hasCalendars ? (
        <EmptyState icon="calendar" action={{ label: "Connect a calendar", onClick: () => navigate(settingsPath("calendar")) }}>
          No calendar is connected yet. Connect Google or Outlook, or add a calendar feed (for example from ProtonMail).
        </EmptyState>
      ) : null}
      {state === "ready" && hasCalendars && total === 0 && view !== "month" ? (
        <p className="muted cal-empty">Nothing on your calendars in this period.</p>
      ) : null}
      {truncated ? <p className="muted" role="status">Showing the first {total} events of this period.</p> : null}
      {hasCalendars && state !== "error" ? body : null}

      {selected ? <EventSheet event={selected} source={sources.get(selected.source_id)} timeZone={timeZone} onClose={() => setSelected(null)} /> : null}
    </section>
  );
}
