import { useEffect } from "react";

interface UndoToastProps {
  message: string;
  onUndo: () => void;
  onDismiss: () => void;
  /** How long the undo stays available. */
  timeoutMs?: number;
}

/** A transient "deleted — Undo" notice. It is a status region, so screen readers announce it. */
export function UndoToast({
  message,
  onUndo,
  onDismiss,
  timeoutMs = 10_000,
}: UndoToastProps) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, timeoutMs);
    return () => window.clearTimeout(timer);
  }, [message, onDismiss, timeoutMs]);

  return (
    <div className="undo-toast" role="status">
      <span>{message}</span>
      <button type="button" onClick={onUndo}>
        Undo
      </button>
      <button
        type="button"
        className="ghost"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  );
}
