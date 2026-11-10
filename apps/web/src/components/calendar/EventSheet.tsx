import { useEffect, useRef, useState } from "react";

import { calendarApi, type CalendarEvent, type CalendarEventDetail, type CalendarSource } from "../../api/client";
import { colorVar, dayHeading, formatTime, otherZoneNote, PROVIDER_NAMES } from "../../lib/calendar";
import { Icon } from "../Icon";

interface EventSheetProps {
  event: CalendarEvent;
  source: CalendarSource | undefined;
  timeZone: string;
  onClose: () => void;
}

function whenText(event: CalendarEvent, timeZone: string): string {
  if (event.is_all_day && event.start_date && event.end_date) {
    const last = new Date(Date.parse(`${event.end_date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    return last <= event.start_date
      ? `${dayHeading(event.start_date, true)}, all day`
      : `${dayHeading(event.start_date, true)} – ${dayHeading(last, true)}, all day`;
  }
  const day = new Intl.DateTimeFormat(undefined, { timeZone, weekday: "long", month: "long", day: "numeric" }).format(new Date(event.start));
  return `${day}, ${formatTime(event.start, timeZone)} – ${formatTime(event.end, timeZone)}`;
}

/**
 * The read-only event detail: a bottom sheet on phones, a side panel on wide screens (CSS decides).
 * It loads the description and provider link from the detail endpoint; the description is untrusted
 * text and is rendered as plain text, never as HTML. Esc and the scrim close it and focus returns to
 * the event that opened it.
 */
export function EventSheet({ event, source, timeZone, onClose }: EventSheetProps) {
  const [detail, setDetail] = useState<CalendarEventDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<Element | null>(document.activeElement);

  useEffect(() => {
    let cancelled = false;
    calendarApi
      .eventDetail(event.id, event.occurrence)
      .then((result) => !cancelled && setDetail(result))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : "Could not load the event details"));
    return () => {
      cancelled = true;
    };
  }, [event.id, event.occurrence]);

  useEffect(() => {
    const returnTo = opener.current;
    closeButton.current?.focus();
    const onKey = (key: KeyboardEvent) => {
      if (key.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (returnTo instanceof HTMLElement) returnTo.focus();
    };
  }, [onClose]);

  const zoneNote = otherZoneNote(event, timeZone);
  const provider = PROVIDER_NAMES[event.provider] ?? event.provider;
  return (
    <>
      <div className="sheet-scrim cal-scrim" onClick={onClose} aria-hidden="true" />
      <div className="cal-detail" role="dialog" aria-modal="true" aria-labelledby="cal-detail-title">
        <div className="sheet-head">
          <h2 id="cal-detail-title" className="sheet-title">{event.title || "(No title)"}</h2>
          <button ref={closeButton} type="button" className="icon-button" aria-label="Close event details" onClick={onClose}>
            <Icon name="x" size={20} />
          </button>
        </div>
        <p className="cal-when">{whenText(event, timeZone)}</p>
        {zoneNote ? <p className="muted">{zoneNote}</p> : null}
        <p className="cal-badges">
          <span className="pill">
            <span className="cal-dot" style={{ background: colorVar(source?.color) }} aria-hidden="true" />
            {source?.name ?? provider}
          </span>
          <span className="pill">{provider}</span>
          <span className="pill">Read only</span>
          {event.is_recurring ? <span className="pill">Repeats</span> : null}
          {event.status === "tentative" ? <span className="pill">Tentative</span> : null}
        </p>
        {event.location ? <p><strong>Where:</strong> {event.location}</p> : null}
        {error ? <p className="error" role="alert">{error}</p> : null}
        {detail?.description ? <p className="cal-description">{detail.description}</p> : null}
        {!detail && !error ? <p className="muted" role="status">Loading details…</p> : null}
        {detail?.web_link ? (
          <p>
            <a href={String(detail.web_link)} target="_blank" rel="noopener noreferrer" className="cal-open-link">
              <Icon name="link" size={16} /> Open in {provider}
            </a>
          </p>
        ) : null}
        <p className="muted cal-fineprint">
          Atlas shows this event but cannot change it. Edit it in {provider}; this view updates on the next sync.
        </p>
      </div>
    </>
  );
}
