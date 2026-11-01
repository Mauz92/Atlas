import { useEffect, useState } from "react";

import type { ReminderTiming } from "../api/client";
import {
  CUSTOM_TIMING_ID,
  MAX_DAYS_BEFORE,
  TIMING_PRESETS,
  presetById,
  presetIdFor,
  validateTiming,
} from "../lib/reminders";

interface ReminderPreferencesProps {
  /** The current default reminder timing (from the hook), or `null` when reminders are off. */
  timing: ReminderTiming | null;
  /** True while the current default is still being read. */
  loading?: boolean;
  /** True while a save is in flight. */
  saving?: boolean;
  /** A failure from loading or saving. */
  error?: string | null;
  /** True after a successful save. */
  saved?: boolean;
  /** Persist a new default timing (`null` turns reminders off). */
  onSave: (timing: ReminderTiming | null) => void;
}

/**
 * The reminder-timing preferences surface (M8-05).
 *
 * Presentational: it renders the timing passed in and calls back to the hook — the vocabulary,
 * presets and validation live in `lib/reminders.ts` (AGENTS.md §6). It shows an explicit loading
 * state, an empty state when no timing is set, an inline error for a bad custom value, a save error,
 * and a "saved" confirmation. Every control is a labelled, keyboard-focusable element and styling
 * uses the shared theme variables, so light and dark both work.
 */
export function ReminderPreferences({
  timing,
  loading = false,
  saving = false,
  error = null,
  saved = false,
  onSave,
}: ReminderPreferencesProps) {
  const [selected, setSelected] = useState(() => presetIdFor(timing));
  const [days, setDays] = useState(() => String(timing?.days_before ?? 0));
  const [atTime, setAtTime] = useState(() => timing?.at_time ?? "09:00");
  const [invalid, setInvalid] = useState<string | null>(null);

  useEffect(() => {
    setSelected(presetIdFor(timing));
    setDays(String(timing?.days_before ?? 0));
    setAtTime(timing?.at_time ?? "09:00");
    setInvalid(null);
  }, [timing]);

  if (loading) {
    return (
      <p className="muted" role="status">
        Loading reminder timing…
      </p>
    );
  }

  const isCustom = selected === CUSTOM_TIMING_ID;

  const handleSave = () => {
    if (isCustom) {
      const result = validateTiming(Number(days), atTime);
      if (!result.ok) {
        setInvalid(result.error);
        return;
      }
      setInvalid(null);
      onSave(result.timing);
      return;
    }
    const preset = presetById(selected);
    if (preset) {
      setInvalid(null);
      onSave(preset.timing);
    }
  };

  return (
    <section className="reminder-preferences">
      <h2>Reminder timing</h2>
      <p className="muted">
        Choose when Atlas reminds you before a task is due. This is your default; it applies to tasks
        that have no timing of their own.
      </p>
      <div className="reminder-form">
        <label htmlFor="reminder-timing">Reminder timing</label>
        <select
          id="reminder-timing"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          disabled={saving}
        >
          {TIMING_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
          <option value={CUSTOM_TIMING_ID}>Custom…</option>
        </select>
        {isCustom ? (
          <div className="reminder-custom">
            <label htmlFor="reminder-days">Days before</label>
            <input
              id="reminder-days"
              type="number"
              min={0}
              max={MAX_DAYS_BEFORE}
              value={days}
              onChange={(event) => setDays(event.target.value)}
              disabled={saving}
            />
            <label htmlFor="reminder-time">Time</label>
            <input
              id="reminder-time"
              type="time"
              value={atTime}
              onChange={(event) => setAtTime(event.target.value)}
              disabled={saving}
            />
          </div>
        ) : null}
        <div className="reminder-actions">
          <button type="button" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save reminder timing"}
          </button>
          {saved ? (
            <span className="reminder-saved" role="status">
              Saved.
            </span>
          ) : null}
        </div>
      </div>
      {invalid ? (
        <p className="error" role="alert">
          {invalid}
        </p>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {timing === null ? (
        <p className="muted">
          Reminders are off. Choose a timing above to get a notification before tasks are due.
        </p>
      ) : null}
    </section>
  );
}
