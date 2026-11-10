import { useSyncExternalStore } from "react";

import { applyTheme, readThemePreference, subscribeTheme, THEME_PREFERENCES } from "../../lib/theme";
import { applyAccentHeadings, readAccent, readAccentHeadings, subscribeAccent } from "../../lib/accent";
import { AccentPicker } from "./AccentPicker";
import { SettingsRow } from "./SettingsRow";

const THEME_LABELS = { system: "System", light: "Light", dark: "Dark" } as const;

export function AppearanceSection() {
  const preference = useSyncExternalStore(subscribeTheme, readThemePreference);
  const headings = useSyncExternalStore(subscribeAccent, readAccentHeadings);
  const accent = useSyncExternalStore(subscribeAccent, readAccent);
  return (
    <div className="settings-group">
      <SettingsRow
        label="Theme"
        labelId="settings-theme-label"
        description="System follows your device. Remembered in this browser only."
      >
        <div className="settings-radio" role="radiogroup" aria-labelledby="settings-theme-label">
          {THEME_PREFERENCES.map((value) => (
            <label key={value}>
              <input
                type="radio"
                name="theme"
                value={value}
                checked={preference === value}
                onChange={() => applyTheme(value)}
              />
              {THEME_LABELS[value]}
            </label>
          ))}
        </div>
      </SettingsRow>
      <SettingsRow
        label="Accent colour"
        labelId="settings-accent-label"
        description="Used for buttons, links and the selected item. Neutral is the default. Overdue, priority and project colours do not change. Remembered in this browser only."
        stacked
      >
        <AccentPicker labelId="settings-accent-label" />
      </SettingsRow>
      <SettingsRow
        label="Headings"
        labelId="settings-headings-label"
        description={
          accent === "neutral"
            ? "Page titles, section headings and note headings take the accent colour. Nothing changes while the accent is Neutral. Body text stays neutral."
            : "Page titles, section headings and note headings take the accent colour. Body text, task titles and labels stay neutral."
        }
      >
        <label className="settings-switch">
          <input
            type="checkbox"
            role="switch"
            checked={headings}
            onChange={(event) => applyAccentHeadings(event.target.checked)}
          />
          Colour headings with the accent
        </label>
        <p className="accent-heading-sample" data-testid="accent-heading-sample">
          Heading preview
        </p>
      </SettingsRow>
    </div>
  );
}
