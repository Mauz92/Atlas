import { useSyncExternalStore } from "react";

import { ACCENTS, applyAccent, DEFAULT_ACCENT, readAccent, subscribeAccent } from "../../lib/accent";
import { Icon } from "../Icon";

/**
 * Accent colour picker (UX-12, ADR-0073): a radio group of named swatches. Choosing one applies it at
 * once (the page is the preview). Native radios keep keyboard behaviour (arrow keys move and select,
 * Tab enters and leaves the group); the selected swatch is shown by a check mark, a heavier outline and
 * bold text as well as by its colour.
 */
export function AccentPicker({ labelId }: { labelId: string }) {
  const accent = useSyncExternalStore(subscribeAccent, readAccent);
  return (
    <div className="accent-picker" role="radiogroup" aria-labelledby={labelId}>
      {ACCENTS.map(({ id, label }) => (
        <label key={id} className="accent-option">
          <input
            type="radio"
            name="accent"
            value={id}
            checked={accent === id}
            onChange={() => applyAccent(id)}
          />
          <span className="accent-card">
            <span className="accent-dot" data-accent={id} aria-hidden="true" />
            <span className="accent-name">
              {label}
              {id === DEFAULT_ACCENT ? <span className="accent-default"> (default)</span> : null}
            </span>
            <span className="accent-check" aria-hidden="true">
              <Icon name="check" size={16} />
            </span>
          </span>
        </label>
      ))}
    </div>
  );
}
