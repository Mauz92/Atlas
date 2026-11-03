import { useCallback, useEffect, useId, useState } from "react";

import {
  notificationsApi,
  type ReminderTiming,
  type TaskReminder as TaskReminderState,
} from "../api/client";
import {
  CUSTOM_TIMING_ID,
  MAX_DAYS_BEFORE,
  TIMING_PRESETS,
  describeTiming,
  presetById,
  presetIdFor,
} from "../lib/reminders";
import { Icon } from "./Icon";

const DEFAULT_ID = "default";
const PRESETS = TIMING_PRESETS.filter((preset) => preset.timing !== null);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}

/**
 * Per-task reminder override (MU-04, M8-05). It only reads and writes the task's reminder timing
 * through the existing endpoint (saved as soon as it is chosen, UX-04); when and whether a reminder is delivered stays the scheduler's
 * business. "Use my default" clears the override. The server validates a custom timing and its
 * message is shown as is.
 */
export function TaskReminder({ taskId }: { taskId: string }) {
  const ids = useId();
  const [state, setState] = useState<TaskReminderState | null>(null);
  const [selected, setSelected] = useState(DEFAULT_ID);
  const [days, setDays] = useState("1");
  const [atTime, setAtTime] = useState("09:00");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = useCallback((next: TaskReminderState) => {
    setState(next);
    setSelected(next.override ? presetIdFor(next.override) : DEFAULT_ID);
    if (next.override) {
      setDays(String(next.override.days_before));
      setAtTime(next.override.at_time);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState(null);
    setError(null);
    notificationsApi
      .taskReminder(taskId)
      .then((next) => {
        if (!cancelled) apply(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, apply]);

  async function save(choice: string) {
    let timing: ReminderTiming | null = null;
    if (choice === CUSTOM_TIMING_ID) {
      timing = { days_before: Number(days), at_time: atTime };
    } else if (choice !== DEFAULT_ID) {
      timing = presetById(choice)?.timing ?? null;
    }
    setBusy(true);
    setError(null);
    try {
      apply(await notificationsApi.setTaskReminder(taskId, timing));
    } catch (err) {
      // Keep the choice and the typed values; the server's words say what to fix.
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // Autosave (UX-04): a choice saves at once; custom values save when a field is left or on Enter.
  const commitCustom = () => void save(CUSTOM_TIMING_ID);
  const onCustomKey = (event: { key: string; preventDefault: () => void }) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitCustom();
    }
  };

  return (
    <section className="task-reminder" aria-label="Reminder">
      <h3 className="task-section-title">Reminder</h3>
      <div className="task-prop">
        <span className="task-prop-label">
          <Icon name="bell" />
          <span>When</span>
        </span>
        <div className="task-prop-value">
          <select
            id={`${ids}-timing`}
            aria-label="Reminder timing for this task"
            className="task-prop-select"
            value={selected}
            onChange={(event) => {
              const next = event.target.value;
              setSelected(next);
              if (next !== CUSTOM_TIMING_ID) void save(next);
            }}
            disabled={busy}
          >
            <option value={DEFAULT_ID}>Use my default</option>
            {PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
            <option value={CUSTOM_TIMING_ID}>Custom…</option>
          </select>
        </div>
      </div>
      {selected === CUSTOM_TIMING_ID ? (
        <div className="task-reminder-custom">
          <label htmlFor={`${ids}-days`}>
            Days before
            <input
              id={`${ids}-days`}
              type="number"
              min={0}
              max={MAX_DAYS_BEFORE}
              value={days}
              onChange={(event) => setDays(event.target.value)}
              onBlur={commitCustom}
              onKeyDown={onCustomKey}
            />
          </label>
          <label htmlFor={`${ids}-at`}>
            Reminder time
            <input
              id={`${ids}-at`}
              type="time"
              value={atTime}
              onChange={(event) => setAtTime(event.target.value)}
              onBlur={commitCustom}
              onKeyDown={onCustomKey}
            />
          </label>
        </div>
      ) : null}
      {state ? (
        <p className="task-detail-hint" role="status">
          {state.effective
            ? `${describeTiming(state.effective)}${state.override ? "" : " (your default)"}`
            : "No reminder"}
          {state.remind_at
            ? ` — next reminder ${new Date(state.remind_at).toLocaleString()}`
            : ""}
        </p>
      ) : null}
      {error ? (
        <p className="task-prop-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
