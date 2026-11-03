import { useCallback, useId, useState } from "react";
import type { ReactNode, Ref } from "react";

import { Menu, type MenuEntry } from "./Menu";

interface MenuButtonProps {
  /** Accessible name of the menu that opens. */
  menuLabel: string;
  entries: MenuEntry[];
  className?: string;
  /** Overrides the button's name; omit to let its visible text name it. */
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
  /** For the owner that anchors something else (a popover) at this button. */
  buttonRef?: Ref<HTMLButtonElement>;
  children: ReactNode;
}

/**
 * A button that opens the shared `Menu` (UX-07): the filter chips, the bulk bar's project picker
 * and the "…" buttons of projects use it. Open state lives here; the menu itself handles focus,
 * keys and dismissal (ADR-0052).
 */
export function MenuButton({
  menuLabel,
  entries,
  className,
  ariaLabel,
  title,
  disabled,
  buttonRef,
  children,
}: MenuButtonProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const id = useId();
  const close = useCallback(() => setAnchor(null), []);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={className}
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-controls={anchor ? id : undefined}
        onClick={(event) => {
          const button = event.currentTarget;
          setAnchor((open) => (open ? null : button));
        }}
      >
        {children}
      </button>
      {anchor ? (
        <Menu id={id} label={menuLabel} anchor={anchor} entries={entries} onClose={close} />
      ) : null}
    </>
  );
}

/** Radio-style menu entries for a list of `[value, label]` choices. */
// eslint-disable-next-line react-refresh/only-export-components
export function choiceEntries(
  choices: readonly (readonly [string, string])[],
  current: string,
  onPick: (value: string) => void,
): MenuEntry[] {
  return choices.map(([value, label]) => ({
    kind: "item",
    id: `choice-${value || "none"}`,
    label,
    checked: value === current,
    onSelect: () => {
      if (value !== current) onPick(value);
    },
  }));
}
