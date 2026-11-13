import { useId, useRef, useState } from "react";

import type { CalendarFeedPreview } from "../../api/client";
import { CALENDAR_COLORS, colorName } from "../../lib/calendar";

/** The server refuses more than this; checking here saves an upload that cannot work. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export async function readCalendarFile(file: File): Promise<{ text: string } | { error: string }> {
  if (file.size > MAX_IMPORT_BYTES) return { error: "That file is larger than 5 MiB." };
  try {
    // FileReader rather than Blob.text(): the same call works in every browser and in the test DOM
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
    return { text };
  } catch {
    return { error: "That file could not be read." };
  }
}

interface ImportFormProps {
  busy: boolean;
  onPreview: (content: string) => Promise<CalendarFeedPreview | null>;
  onAdd: (file: { content: string; name: string; color?: string }) => Promise<boolean>;
}

/**
 * Import a calendar from an `.ics` file (M5-12, ADR-0076 D4) for calendars that offer no link. The file is
 * read in the browser and sent as text; "Check file" parses it on the server and reports a count (nothing
 * is saved). The imported calendar is read-only, never fetched, and can be replaced later by a newer file.
 */
export function ImportForm({ busy, onPreview, onAdd }: ImportFormProps) {
  const ids = { file: useId(), name: useId(), color: useId() };
  const input = useRef<HTMLInputElement>(null);
  const [content, setContent] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [name, setName] = useState("");
  const [color, setColor] = useState("");
  const [preview, setPreview] = useState<CalendarFeedPreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const ready = content !== null && name.trim().length > 0;

  async function choose(file: File | undefined) {
    setPreview(null);
    setProblem(null);
    setContent(null);
    if (!file) return;
    const read = await readCalendarFile(file);
    if ("error" in read) {
      setProblem(read.error);
      return;
    }
    setContent(read.text);
    setFileName(file.name);
    if (!name.trim()) setName(file.name.replace(/\.(ics|ical|ifb)$/i, "").slice(0, 200));
  }

  async function check() {
    if (content === null) return;
    const result = await onPreview(content);
    setPreview(result);
    if (result?.name && !name.trim()) setName(result.name);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || content === null) return;
    if (await onAdd({ content, name: name.trim(), color: color || undefined })) {
      setContent(null);
      setFileName("");
      setName("");
      setColor("");
      setPreview(null);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <form className="cal-feed-form" onSubmit={(event) => void submit(event)} autoComplete="off">
      <h3>Import a calendar file (.ics)</h3>
      <p className="muted">
        For a calendar that offers no link: export it as an <strong>.ics</strong> file (Google, Outlook, Apple and Proton all can) and
        choose the file here. It is read once and stored in Atlas; it is not refreshed. To update it later, replace the file.
      </p>
      <label htmlFor={ids.file}>Calendar file</label>
      <input
        ref={input}
        id={ids.file}
        type="file"
        accept=".ics,.ical,.ifb,text/calendar"
        onChange={(event) => void choose(event.target.files?.[0])}
      />
      {fileName ? <p className="muted">{fileName}</p> : null}
      <label htmlFor={ids.name}>Calendar name</label>
      <input id={ids.name} value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
      <label htmlFor={ids.color}>Calendar colour</label>
      <select id={ids.color} value={color} onChange={(event) => setColor(event.target.value)}>
        <option value="">Automatic</option>
        {CALENDAR_COLORS.map((value) => (
          <option key={value} value={value}>
            {colorName(value)}
          </option>
        ))}
      </select>
      {problem ? (
        <p role="alert" className="error">
          {problem}
        </p>
      ) : null}
      {preview ? (
        <p role="status" className="cal-preview">
          Readable calendar with {preview.event_count} {preview.event_count === 1 ? "event" : "events"}
          {preview.skipped > 0 ? ` (${preview.skipped} could not be read)` : ""}.
        </p>
      ) : null}
      <div className="cal-actions">
        <button type="button" disabled={content === null || busy} onClick={() => void check()}>
          Check file
        </button>
        <button type="submit" className="primary" disabled={!ready || busy}>
          Import
        </button>
      </div>
    </form>
  );
}
