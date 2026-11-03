import { useId, useRef, useState } from "react";
import type { FormEvent } from "react";

interface QuickCaptureProps {
  /** Called with the trimmed title; the input is cleared only when it resolves. */
  onCapture: (title: string) => Promise<void>;
  placeholder?: string;
  label?: string;
  /** Put the cursor back in the field after a task was added (the capture sheet adds several in a row). */
  refocus?: boolean;
}

/**
 * Quick capture requires a title and nothing else (PRODUCT_SPEC §5.7). Keeping the input form
 * here means every view captures tasks the same way.
 */
export function QuickCapture({
  onCapture,
  placeholder = "Add a task…",
  label = "Task title",
  refocus = false,
}: QuickCaptureProps) {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  // A second submit while one is in flight (double tap, Enter twice) must not add a second task.
  const inFlight = useRef(false);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canSubmit = title.trim().length > 0 && !busy;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const value = title.trim();
    if (!value || inFlight.current) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await onCapture(value);
      setTitle("");
      if (refocus) input.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add the task");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <form className="quick-capture" onSubmit={onSubmit}>
      <label className="sr-only" htmlFor={inputId}>
        {label}
      </label>
      <input
        ref={input}
        id={inputId}
        type="text"
        required
        placeholder={placeholder}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <button type="submit" className="primary" disabled={!canSubmit}>
        {busy ? "Adding…" : "Add"}
      </button>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
