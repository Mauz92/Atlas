import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { Icon, type IconName } from "./Icon";

/**
 * One shared, accessible menu/popover (UX-03, ADR-0052): the task row "…" menu, its quick-action
 * pickers (date, project, priority) and the board card menu all render through it.
 *
 * - WAI-ARIA menu pattern: `role="menu"` with `menuitem` / `menuitemradio` children; focus moves
 *   into the menu when it opens (the checked item, else the first), ↑ ↓ Home End move, → opens a
 *   submenu, ← goes back, a letter jumps to the next item starting with it, Enter/Space activate.
 * - Esc, Tab or choosing an item close it and return focus to the element that opened it; a
 *   pointer press outside closes it without moving focus.
 * - A submenu replaces the current view (with a "Back" item) instead of flying out, so it works the
 *   same at phone width. A date view is a small `role="dialog"` with a labelled date field.
 * - It is rendered in a portal (inside the opener's landmark) so a list's `overflow: hidden` never
 *   clips it, and promoted to the browser's top layer with the native Popover API
 *   (`popover="manual"`) where available; the open/close logic stays here so it behaves the same in
 *   every browser and in jsdom.
 */
export type MenuEntry =
  | {
      kind: "item";
      id: string;
      label: string;
      icon?: IconName;
      /** Short secondary text on the right (a weekday, a current value). */
      hint?: string;
      /** Present for a radio-style choice; `true` marks the current value. */
      checked?: boolean;
      danger?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    }
  | {
      kind: "submenu";
      id: string;
      label: string;
      icon?: IconName;
      hint?: string;
      entries: MenuEntry[];
    }
  | {
      kind: "date";
      id: string;
      /** The item's text, e.g. "Pick a date…". */
      label: string;
      icon?: IconName;
      hint?: string;
      /** The date view's accessible name, e.g. "Pick a date for Pay rent". */
      title: string;
      /** The field's label. */
      fieldLabel: string;
      /** `YYYY-MM-DD` to start from, if any. */
      value?: string;
      onPick: (date: string) => void;
    }
  | { kind: "separator"; id: string };

export type MenuCloseReason = "select" | "escape" | "tab" | "outside";

interface MenuProps {
  /** The menu element's id (the trigger points at it with `aria-controls`). */
  id: string;
  /** Accessible name of the top-level menu. */
  label: string;
  /** The element the menu is placed at; focus returns to it. */
  anchor: HTMLElement;
  entries: MenuEntry[];
  /** Ids of submenus (or a date entry) to open straight away, e.g. `["project"]`. */
  initialPath?: string[];
  onClose: (reason: MenuCloseReason) => void;
}

type View =
  | { kind: "menu"; label: string; entries: MenuEntry[] }
  | { kind: "date"; entry: Extract<MenuEntry, { kind: "date" }> };

function resolve(label: string, entries: MenuEntry[], path: string[]): View {
  let view: View = { kind: "menu", label, entries };
  for (const id of path) {
    if (view.kind !== "menu") break;
    const next: MenuEntry | undefined = view.entries.find((entry) => entry.id === id);
    if (next?.kind === "submenu") {
      view = { kind: "menu", label: next.label, entries: next.entries };
    } else if (next?.kind === "date") {
      view = { kind: "date", entry: next };
    } else {
      break;
    }
  }
  return view;
}

const ITEM = '[role="menuitem"], [role="menuitemradio"]';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function items(root: HTMLElement | null): HTMLElement[] {
  return root
    ? [...root.querySelectorAll<HTMLElement>(ITEM)].filter(
        (item) => item.getAttribute("aria-disabled") !== "true",
      )
    : [];
}

/** Below the anchor, right edges aligned; flipped above or clamped when the viewport is short. */
function place(popup: HTMLElement, anchor: HTMLElement) {
  const margin = 8;
  const a = anchor.getBoundingClientRect();
  const m = popup.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = a.right - m.width;
  if (left < margin) left = a.left;
  left = Math.max(margin, Math.min(left, vw - m.width - margin));
  let top = a.bottom + 4;
  if (top + m.height > vh - margin && a.top - 4 - m.height >= margin) {
    top = a.top - 4 - m.height;
  }
  top = Math.max(margin, Math.min(top, vh - m.height - margin));
  popup.style.left = `${Math.round(left)}px`;
  popup.style.top = `${Math.round(top)}px`;
}

export function Menu({ id, label, anchor, entries, initialPath = [], onClose }: MenuProps) {
  const [path, setPath] = useState<string[]>(initialPath);
  const [date, setDate] = useState("");
  const popup = useRef<HTMLDivElement>(null);
  const view = resolve(label, entries, path);

  const close = useCallback(
    (reason: MenuCloseReason) => {
      if (reason !== "outside" && anchor.isConnected) {
        anchor.focus();
      }
      onClose(reason);
    },
    [anchor, onClose],
  );

  // Top layer (where supported), then position. Runs again when the view (and its size) changes.
  useLayoutEffect(() => {
    const element = popup.current;
    if (!element) return;
    if (typeof element.showPopover === "function" && !element.hasAttribute("popover")) {
      element.setAttribute("popover", "manual");
      try {
        element.showPopover();
      } catch {
        // Already shown, or not connected yet: the fixed position below still applies.
      }
    }
    place(element, anchor);
  }, [anchor, path]);

  // Focus follows the view: the date field, else the checked choice, else the first item.
  useLayoutEffect(() => {
    const element = popup.current;
    if (!element) return;
    const target =
      element.querySelector<HTMLElement>("input") ??
      element.querySelector<HTMLElement>('[aria-checked="true"]') ??
      items(element)[0];
    target?.focus();
    if (view.kind === "date") setDate(view.entry.value ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    const reposition = () => popup.current && place(popup.current, anchor);
    function onPointerDown(event: Event) {
      const target = event.target as Node;
      if (popup.current?.contains(target) || anchor.contains(target)) return;
      close("outside");
    }
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [anchor, close]);

  function move(to: "next" | "prev" | "first" | "last") {
    const list = items(popup.current);
    if (list.length === 0) return;
    const at = list.indexOf(document.activeElement as HTMLElement);
    const index =
      to === "first"
        ? 0
        : to === "last"
          ? list.length - 1
          : to === "next"
            ? (at + 1) % list.length
            : (at - 1 + list.length) % list.length;
    list[index].focus();
  }

  // Type-ahead like a native list: letters typed in quick succession form a prefix; the same
  // letter repeated cycles through the items that start with it.
  const typed = useRef({ text: "", at: 0 });
  function typeahead(letter: string) {
    const now = Date.now();
    const text = now - typed.current.at < 700 ? typed.current.text + letter : letter;
    typed.current = { text, at: now };
    const cycling = [...text].every((char) => char === text[0]);
    const prefix = cycling ? text[0] : text;
    const list = items(popup.current);
    const at = list.indexOf(document.activeElement as HTMLElement);
    const start = cycling ? at + 1 : Math.max(at, 0);
    const ordered = [...list.slice(start), ...list.slice(0, start)];
    ordered
      .find((item) => item.textContent?.trim().toLowerCase().startsWith(prefix))
      ?.focus();
  }

  function onKeyDown(event: ReactKeyboardEvent) {
    // Keys handled here never reach the row, the page or the task panel's Esc handler.
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (event.key === "Escape") {
      handled();
      close("escape");
      return;
    }
    if (view.kind === "date") {
      if (event.key === "Tab") {
        // A two-control dialog: Tab cycles between the field and its buttons.
        const controls = [
          ...(popup.current?.querySelectorAll<HTMLElement>("input, button") ?? []),
        ];
        const at = controls.indexOf(document.activeElement as HTMLElement);
        const next = (at + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
        handled();
        controls[next]?.focus();
      }
      return;
    }
    const current = document.activeElement as HTMLElement | null;
    switch (event.key) {
      case "Tab":
        handled();
        close("tab");
        return;
      case "ArrowDown":
        handled();
        move("next");
        return;
      case "ArrowUp":
        handled();
        move("prev");
        return;
      case "Home":
        handled();
        move("first");
        return;
      case "End":
        handled();
        move("last");
        return;
      case "ArrowRight":
        if (current?.dataset.opens) {
          handled();
          current.click();
        }
        return;
      case "ArrowLeft":
        if (path.length > 0) {
          handled();
          setPath(path.slice(0, -1));
        }
        return;
      default:
        if (event.key.length === 1 && /\S/.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
          handled();
          typeahead(event.key.toLowerCase());
        }
    }
  }

  function submitDate(event: FormEvent) {
    event.preventDefault();
    if (view.kind !== "date" || !DATE.test(date)) return;
    const pick = view.entry.onPick;
    close("select");
    pick(date);
  }

  const body =
    view.kind === "date" ? (
      <div
        id={id}
        ref={popup}
        className="menu menu-dialog"
        role="dialog"
        aria-label={view.entry.title}
        onKeyDown={onKeyDown}
      >
        <form className="menu-date" onSubmit={submitDate}>
          <label>
            {view.entry.fieldLabel}
            <input
              type="date"
              value={date}
              required
              onChange={(event) => setDate(event.target.value)}
            />
          </label>
          <div className="menu-date-actions">
            {path.length > 1 || initialPath.length === 0 ? (
              <button type="button" className="ghost" onClick={() => setPath(path.slice(0, -1))}>
                Back
              </button>
            ) : null}
            <button type="submit" className="primary" disabled={!DATE.test(date)}>
              Set date
            </button>
          </div>
        </form>
      </div>
    ) : (
      <div
        id={id}
        ref={popup}
        className="menu"
        role="menu"
        aria-label={view.label}
        onKeyDown={onKeyDown}
      >
        {path.length > 0 ? (
          <>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="menu-item menu-back"
              onClick={() => setPath(path.slice(0, -1))}
            >
              <Icon name="chevron-left" />
              <span className="menu-label">Back</span>
            </button>
            <div role="separator" className="menu-separator" />
          </>
        ) : null}
        {view.entries.map((entry) => {
          if (entry.kind === "separator") {
            return <div key={entry.id} role="separator" className="menu-separator" />;
          }
          const radio = entry.kind === "item" && entry.checked !== undefined;
          const opens = entry.kind !== "item";
          const disabled = entry.kind === "item" && entry.disabled;
          return (
            <button
              key={entry.id}
              type="button"
              role={radio ? "menuitemradio" : "menuitem"}
              aria-checked={radio ? Boolean(entry.kind === "item" && entry.checked) : undefined}
              aria-haspopup={opens ? (entry.kind === "date" ? "dialog" : "menu") : undefined}
              aria-disabled={disabled ? true : undefined}
              data-opens={opens ? "true" : undefined}
              tabIndex={-1}
              className={`menu-item${entry.kind === "item" && entry.danger ? " menu-danger" : ""}`}
              onClick={() => {
                if (disabled) return;
                if (entry.kind === "item") {
                  close("select");
                  entry.onSelect();
                } else {
                  setPath([...path, entry.id]);
                }
              }}
            >
              {entry.icon ? <Icon name={entry.icon} /> : <span className="menu-icon-space" />}
              <span className="menu-label">{entry.label}</span>
              {entry.hint ? (
                // Visual context only (a weekday, the current value); the name stays the label.
                <span className="menu-hint" aria-hidden="true">
                  {entry.hint}
                </span>
              ) : null}
              {opens ? <Icon name="chevron-right" className="menu-chevron" /> : null}
              {radio ? (
                <span className="menu-check">
                  {entry.kind === "item" && entry.checked ? <Icon name="check" /> : null}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    );

  // Inside the opener's landmark (so all content stays in landmarks); the top layer or fixed
  // positioning keeps it unclipped wherever it is attached.
  const host = anchor.closest<HTMLElement>("main, aside, nav, [role='dialog']") ?? document.body;
  return createPortal(body, host);
}
