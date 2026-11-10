import type { ReactNode } from "react";

interface SettingsRowProps {
  /** The setting's name. With `htmlFor` it labels the control; otherwise `labelId` names a group. */
  label: string;
  htmlFor?: string;
  labelId?: string;
  /** One line explaining the setting; `descriptionId` lets the control reference it. */
  description?: ReactNode;
  descriptionId?: string;
  /** The control (input, buttons, radios), drawn on the right. */
  children: ReactNode;
  /** A wide control (a swatch grid) goes below the text instead of beside it. */
  stacked?: boolean;
}

/** "Label and description on the left, control on the right" (UX_AUDIT §4.3). */
export function SettingsRow({
  label,
  htmlFor,
  labelId,
  description,
  descriptionId,
  children,
  stacked,
}: SettingsRowProps) {
  return (
    <div className={stacked ? "settings-row settings-row-stacked" : "settings-row"}>
      <div className="settings-row-text">
        {htmlFor ? (
          <label htmlFor={htmlFor}>{label}</label>
        ) : (
          <span id={labelId} className="settings-row-label">
            {label}
          </span>
        )}
        {description ? (
          <p id={descriptionId} className="hint">
            {description}
          </p>
        ) : null}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}
