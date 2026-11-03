import { useSyncExternalStore } from "react";

import { applyTheme, readThemePreference, subscribeTheme, THEME_PREFERENCES } from "../../lib/theme";
import { SettingsRow } from "./SettingsRow";

const THEME_LABELS = { system: "System", light: "Light", dark: "Dark" } as const;

export function AppearanceSection() {
  const preference = useSyncExternalStore(subscribeTheme, readThemePreference);
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
    </div>
  );
}
