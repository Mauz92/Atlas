import { useId, useState } from "react";

import type { CalendarFeedPreview } from "../../api/client";
import { CALENDAR_COLORS, colorName } from "../../lib/calendar";

interface FeedFormProps {
  busy: boolean;
  onPreview: (url: string) => Promise<CalendarFeedPreview | null>;
  onAdd: (feed: { url: string; name: string; color?: string }) => Promise<boolean>;
}

/**
 * Add a secret ICS feed (Proton "Share via link" or any ICS URL). The URL is a secret: the field is
 * a masked input (revealed only on request), the value is cleared after saving, and it is never put
 * in a URL, a log or local storage. "Test" fetches the feed once and reports a count; nothing is saved.
 */
export function FeedForm({ busy, onPreview, onAdd }: FeedFormProps) {
  const ids = { url: useId(), name: useId(), color: useId() };
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [color, setColor] = useState("");
  const [reveal, setReveal] = useState(false);
  const [preview, setPreview] = useState<CalendarFeedPreview | null>(null);
  const ready = url.trim().length >= 8 && name.trim().length > 0;

  async function test() {
    setPreview(null);
    const result = await onPreview(url.trim());
    setPreview(result);
    if (result?.name && !name.trim()) setName(result.name);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready) return;
    if (await onAdd({ url: url.trim(), name: name.trim(), color: color || undefined })) {
      setUrl("");
      setName("");
      setColor("");
      setPreview(null);
      setReveal(false);
    }
  }

  return (
    <form className="cal-feed-form" onSubmit={(event) => void submit(event)} autoComplete="off">
      <h3>Add a calendar feed (ICS)</h3>
      <p className="muted">
        For ProtonMail: in Proton Calendar choose <strong>Share via link</strong>, create a view-only link and paste it
        here. The link is a secret; Atlas stores it encrypted and shows only the host afterwards.
      </p>
      <label htmlFor={ids.url}>Feed link (secret)</label>
      <div className="cal-feed-url">
        <input
          id={ids.url}
          type={reveal ? "text" : "password"}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
            setPreview(null);
          }}
          placeholder="https://calendar.proton.me/…"
        />
        <label className="cal-inline">
          <input type="checkbox" checked={reveal} onChange={(event) => setReveal(event.target.checked)} />
          Show link
        </label>
      </div>
      <label htmlFor={ids.name}>Name</label>
      <input id={ids.name} value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
      <label htmlFor={ids.color}>Colour</label>
      <select id={ids.color} value={color} onChange={(event) => setColor(event.target.value)}>
        <option value="">Automatic</option>
        {CALENDAR_COLORS.map((value) => (
          <option key={value} value={value}>
            {colorName(value)}
          </option>
        ))}
      </select>
      {preview ? (
        <p role="status" className="cal-preview">
          Readable calendar with {preview.event_count} {preview.event_count === 1 ? "event" : "events"}
          {preview.skipped > 0 ? ` (${preview.skipped} could not be read)` : ""}.
        </p>
      ) : null}
      <div className="cal-actions">
        <button type="button" disabled={!ready || busy} onClick={() => void test()}>
          Test feed
        </button>
        <button type="submit" className="primary" disabled={!ready || busy}>
          Add feed
        </button>
      </div>
    </form>
  );
}
