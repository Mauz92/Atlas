import { useEffect, useId, useState } from "react";

import { tasksApi } from "../api/client";
import { REPEAT_PRESETS, repeatChoice } from "../lib/taskForm";
import { formatDue } from "../lib/tasks";

interface TaskRepeatProps {
  /** The RRULE text ("" for a task that does not repeat). */
  value: string;
  onChange: (rule: string) => void;
  /** Naive wall-clock anchor (`YYYY-MM-DDTHH:mm:ss`) the series would start from, or null. */
  anchor: string | null;
  /** The zone the anchor is read in. */
  timeZone?: string;
  /** An occurrence of an existing series: the rule is shown but cannot be changed from here. */
  readOnly?: boolean;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}

/**
 * The repeat picker (MU-04): none, daily, weekly, monthly or a custom RRULE. The client never
 * interprets a rule (AGENTS.md §7.4); it shows what the server's preview endpoint says the next
 * occurrences are, or the server's validation message verbatim.
 */
export function TaskRepeat({
  value,
  onChange,
  anchor,
  timeZone,
  readOnly = false,
}: TaskRepeatProps) {
  const ids = useId();
  const [custom, setCustom] = useState(repeatChoice(value) === "custom");
  const [preview, setPreview] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choice = custom ? "custom" : repeatChoice(value);
  const rule = value.trim();

  useEffect(() => {
    setPreview(null);
    setError(null);
    if (rule === "" || anchor === null) {
      return;
    }
    let cancelled = false;
    // Debounced so typing a custom rule does not send a request per keystroke.
    const timer = window.setTimeout(() => {
      tasksApi
        .previewRecurrence(rule, anchor, timeZone)
        .then((result) => {
          if (!cancelled) setPreview(result.occurrences);
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(errorMessage(err));
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [rule, anchor, timeZone]);

  function choose(next: string) {
    if (next === "custom") {
      setCustom(true);
      return;
    }
    setCustom(false);
    onChange(REPEAT_PRESETS.find((preset) => preset.id === next)?.rule ?? "");
  }

  return (
    <fieldset className="task-repeat" disabled={readOnly}>
      <label htmlFor={`${ids}-repeat`}>Repeat</label>
      <select
        id={`${ids}-repeat`}
        value={choice}
        onChange={(event) => choose(event.target.value)}
      >
        <option value="">Does not repeat</option>
        {REPEAT_PRESETS.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {preset.label}
          </option>
        ))}
        <option value="custom">Custom (RRULE)…</option>
      </select>
      {choice === "custom" ? (
        <>
          <label htmlFor={`${ids}-rrule`}>Custom rule</label>
          <input
            id={`${ids}-rrule`}
            type="text"
            placeholder="FREQ=WEEKLY;BYDAY=MO,WE"
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        </>
      ) : null}
      {readOnly ? (
        <p className="muted task-detail-hint">
          This task is part of a repeating series; the rule is set on the
          series.
        </p>
      ) : null}
      {rule !== "" && anchor === null ? (
        <p className="muted task-detail-hint">
          Set a due date or start to repeat from.
        </p>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {preview && preview.length > 0 ? (
        <div className="task-repeat-preview">
          <p className="muted task-detail-hint">Next occurrences</p>
          <ul aria-label="Next occurrences">
            {preview.map((instant) => (
              <li key={instant}>{formatDue(instant, timeZone)}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </fieldset>
  );
}
