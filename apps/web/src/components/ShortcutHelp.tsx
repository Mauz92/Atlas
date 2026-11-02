import { useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";

import { SHORTCUT_GROUPS } from "../lib/shortcuts";

/**
 * The keyboard shortcut help overlay (MU-08). A modal dialog: focus moves into it, Tab stays
 * inside, Esc or the Close button dismiss it and focus returns to where it was.
 */
export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement;
    close.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus();
      }
    };
  }, []);

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      // preventDefault tells the task detail's document-level Esc handler to stand down.
      event.preventDefault();
      onClose();
    } else if (event.key === "Tab") {
      // The only focusable element is Close, so Tab simply stays on it.
      event.preventDefault();
      close.current?.focus();
    }
  }

  return (
    <div
      className="palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialog}
        className="shortcut-help"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-help-title"
        onKeyDown={onKeyDown}
      >
        <div className="shortcut-help-header">
          <h2 id="shortcut-help-title">Keyboard shortcuts</h2>
          <button ref={close} type="button" className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group.title} aria-label={group.title}>
            <h3>{group.title}</h3>
            <dl className="shortcut-list">
              {group.items.map((item) => (
                <div key={item.keys + item.action}>
                  <dt>
                    <kbd>{item.keys}</kbd>
                  </dt>
                  <dd>{item.action}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </div>
  );
}
