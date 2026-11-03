import { useEffect, useLayoutEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";

import { useMediaQuery } from "../hooks/useMediaQuery";
import { SHEET_QUERY, promoteToTopLayer } from "../lib/phone";
import { placePopup } from "../lib/placePopup";

interface PopoverProps {
  /** Accessible name of the dialog. */
  label: string;
  /** The control it is placed at; focus returns to it on Esc. */
  anchor: HTMLElement;
  onClose: () => void;
  children: ReactNode;
}

const FOCUSABLE = "input, button, select, textarea, [href]";

/**
 * A small anchored dialog (UX-07) for what a menu cannot hold: the Due chip's date range and the
 * name of a saved view. Same placement, top-layer promotion and dismissal rules as `Menu`
 * (ADR-0052): Esc closes and returns focus to the anchor, a press outside closes without moving
 * focus, Tab cycles inside. It is not modal, so the page behind stays readable. On a phone or a
 * device with no hover (UX-10, ADR-0063) it is a bottom sheet with a scrim, like `Menu`.
 */
export function Popover({ label, anchor, onClose, children }: PopoverProps) {
  const popup = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const sheet = useMediaQuery(SHEET_QUERY, false);

  useLayoutEffect(() => {
    const element = popup.current;
    if (!element) return;
    if (sheet) promoteToTopLayer(scrim.current);
    if (typeof element.showPopover === "function" && !element.hasAttribute("popover")) {
      element.setAttribute("popover", "manual");
      try {
        element.showPopover();
      } catch {
        // Not connected yet: the fixed position below still applies.
      }
    }
    if (sheet) {
      element.style.left = "";
      element.style.top = "";
    } else {
      placePopup(element, anchor);
    }
    element.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [anchor, sheet]);

  useEffect(() => {
    const reposition = () => popup.current && !sheet && placePopup(popup.current, anchor);
    function onPointerDown(event: Event) {
      const target = event.target as Node;
      if (popup.current?.contains(target) || anchor.contains(target)) return;
      onClose();
      // A press on a sheet's scrim returns focus to the opener once the press has moved it.
      if (scrim.current?.contains(target)) window.setTimeout(() => anchor.isConnected && anchor.focus(), 0);
    }
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [anchor, onClose, sheet]);

  function onKeyDown(event: ReactKeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (anchor.isConnected) anchor.focus();
      onClose();
    } else if (event.key === "Tab") {
      const controls = [
        ...(popup.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []),
      ].filter((control) => !control.hasAttribute("disabled"));
      if (controls.length === 0) return;
      const at = controls.indexOf(document.activeElement as HTMLElement);
      const next = (at + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
      event.preventDefault();
      controls[next].focus();
    }
  }

  const host = anchor.closest<HTMLElement>("main, aside, nav, [role='dialog']") ?? document.body;
  return createPortal(
    <>
      {sheet ? <div ref={scrim} className="sheet-scrim" aria-hidden="true" /> : null}
      <div
        ref={popup}
        className={`menu popover${sheet ? " is-sheet" : ""}`}
        role="dialog"
        aria-label={label}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </>,
    host,
  );
}
