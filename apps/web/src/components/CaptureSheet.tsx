import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import { createPortal } from "react-dom";

import { useKeyboardInset } from "../hooks/useKeyboardInset";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { PHONE_QUERY, promoteToTopLayer } from "../lib/phone";
import { Icon } from "./Icon";
import { QuickCapture } from "./QuickCapture";

interface CaptureFabProps {
  /** The page's own capture function (the same one its inline field uses). */
  onCapture: (title: string) => Promise<void>;
  placeholder?: string;
  /** Where the task lands, said in the confirmation ("Inbox", "Today", the project's name). */
  destination: string;
}

const FOCUSABLE = "input, button, select, textarea, [href]";

/**
 * Phone capture (UX-10, ADR-0063): a floating button above the bottom nav that opens a bottom
 * sheet around the shared `QuickCapture` form. It is the same form, label ("Task title"), validation
 * and API call as the inline field; the page passes its own `onCapture`, so no capture logic is
 * duplicated here. Nothing is rendered above 720 px, where the inline field stays.
 */
export function CaptureFab({ onCapture, placeholder, destination }: CaptureFabProps) {
  const phone = useMediaQuery(PHONE_QUERY, false);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  if (!phone) return null;
  return (
    <>
      <button
        ref={button}
        type="button"
        className="capture-fab"
        aria-label="Capture a task"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Icon name="plus" size={24} />
      </button>
      {open ? (
        <CaptureSheet
          opener={button}
          onCapture={onCapture}
          placeholder={placeholder}
          destination={destination}
          onClose={close}
        />
      ) : null}
    </>
  );
}

interface CaptureSheetProps extends CaptureFabProps {
  opener: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

/**
 * A modal bottom sheet. Opening moves focus to the field and makes the page behind it `inert`;
 * Esc, the scrim and "Close" close it and focus returns to the button; Tab stays inside. It stays
 * open after an add (the field is cleared and focused again) so several tasks can be captured in a
 * row; a polite status says where the last one went. The on-screen keyboard is accounted for by
 * lifting the sheet by the visual-viewport inset (`--kb`).
 */
function CaptureSheet({ opener, onCapture, placeholder, destination, onClose }: CaptureSheetProps) {
  const sheet = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const inset = useKeyboardInset();
  const [added, setAdded] = useState<string | null>(null);
  const host = opener.current?.closest("main") ?? document.body;

  useLayoutEffect(() => {
    const returnTo = opener.current;
    const page = returnTo?.closest<HTMLElement>(".page") ?? null;
    promoteToTopLayer(scrim.current);
    promoteToTopLayer(sheet.current);
    page?.setAttribute("inert", "");
    sheet.current?.querySelector<HTMLElement>("input")?.focus();
    return () => {
      page?.removeAttribute("inert");
      if (returnTo?.isConnected) returnTo.focus();
    };
  }, [opener]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      } else if (event.key === "Tab") {
        const list = [...(sheet.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(
          (control) => !control.hasAttribute("disabled"),
        );
        if (list.length === 0) return;
        const active = document.activeElement as HTMLElement | null;
        const first = list[0];
        const last = list[list.length - 1];
        if (!active || !sheet.current?.contains(active)) {
          event.preventDefault();
          first.focus();
        } else if (event.shiftKey && active === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  async function capture(title: string) {
    await onCapture(title);
    setAdded(title);
  }

  return createPortal(
    <>
      <div ref={scrim} className="sheet-scrim" aria-hidden="true" onClick={onClose} />
      <div
        ref={sheet}
        className="sheet capture-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{ "--kb": `${inset}px` } as CSSProperties}
      >
        <div className="sheet-head">
          <p id={titleId} className="sheet-title">
            Capture a task
          </p>
          <button type="button" className="ghost icon-button" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={20} />
          </button>
        </div>
        <QuickCapture onCapture={capture} placeholder={placeholder} refocus />
        <p className="sheet-status muted" role="status">
          {added ? `Added “${added}” to ${destination}.` : ""}
        </p>
      </div>
    </>,
    host,
  );
}
