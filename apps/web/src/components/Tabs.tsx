import type { KeyboardEvent as ReactKeyboardEvent } from "react";

export interface TabItem<T extends string> {
  id: T;
  label: string;
}

interface TabsProps<T extends string> {
  /** Accessible name of the tab list. */
  label: string;
  tabs: readonly TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  /** Prefix of the ids tab and panel share (see `tabId` / `panelId`). */
  idPrefix: string;
}

// eslint-disable-next-line react-refresh/only-export-components
export const tabId = (prefix: string, id: string) => `${prefix}-tab-${id}`;
// eslint-disable-next-line react-refresh/only-export-components
export const panelId = (prefix: string, id: string) => `${prefix}-panel-${id}`;

/**
 * WAI-ARIA tabs (UX-07): one tab in the tab order, ← → Home End move and select (automatic
 * activation, since switching a panel is instant and has no side effects). The caller renders the
 * `role="tabpanel"` with `id={panelId(...)}` and `aria-labelledby={tabId(...)}`.
 */
export function Tabs<T extends string>({ label, tabs, value, onChange, idPrefix }: TabsProps<T>) {
  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const at = tabs.findIndex((tab) => tab.id === value);
    const next =
      event.key === "ArrowRight"
        ? (at + 1) % tabs.length
        : event.key === "ArrowLeft"
          ? (at - 1 + tabs.length) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    onChange(tabs[next].id);
    document.getElementById(tabId(idPrefix, tabs[next].id))?.focus();
  }

  return (
    <div className="tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          id={tabId(idPrefix, tab.id)}
          type="button"
          role="tab"
          aria-selected={tab.id === value}
          aria-controls={panelId(idPrefix, tab.id)}
          tabIndex={tab.id === value ? 0 : -1}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
