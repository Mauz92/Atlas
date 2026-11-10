import { useId, useState } from "react";

import { CALENDAR_COLORS, colorName, colorVar } from "../../lib/calendar";

interface ColorPickerProps {
  /** What the colour is for, e.g. the calendar's name (used in the accessible labels). */
  label: string;
  value: string | null;
  disabled?: boolean;
  onChange: (color: string) => void;
}

/**
 * Pick one of the eight palette colours (the `--cal-N` tokens; never a free-form colour). The
 * swatches are a radio group of 44px targets that wrap, so nothing scrolls sideways at 360px. The
 * colour is always paired with its name in the accessible label: colour never carries meaning alone.
 */
export function ColorPicker({ label, value, disabled, onChange }: ColorPickerProps) {
  const [open, setOpen] = useState(false);
  const groupId = useId();
  return (
    <div className="cal-color">
      <button
        type="button"
        className="cal-color-button"
        aria-expanded={open}
        aria-controls={groupId}
        aria-label={`Colour of ${label}: ${colorName(value)}`}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="cal-dot" style={{ background: colorVar(value) }} aria-hidden="true" />
        <span className="cal-color-name">{colorName(value)}</span>
      </button>
      {open ? (
        <div id={groupId} role="radiogroup" aria-label={`Colour for ${label}`} className="cal-swatches">
          {CALENDAR_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={value === color}
              aria-label={colorName(color)}
              className={`cal-swatch${value === color ? " is-selected" : ""}`}
              onClick={() => {
                onChange(color);
                setOpen(false);
              }}
            >
              <span className="cal-dot" style={{ background: colorVar(color) }} aria-hidden="true" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
