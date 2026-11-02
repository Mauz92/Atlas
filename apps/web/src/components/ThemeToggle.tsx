import { useSyncExternalStore } from "react";

import { readTheme, subscribeTheme, toggleTheme } from "../lib/theme";
import { Icon } from "./Icon";

/** Switches to the opposite of the theme shown now (an explicit choice; Settings offers System). */
export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, readTheme);
  const label = `Switch to ${theme === "dark" ? "light" : "dark"} theme`;

  return (
    <button type="button" className="ghost icon-button" onClick={toggleTheme} aria-label={label} title={label}>
      <Icon name={theme === "dark" ? "sun" : "moon"} />
    </button>
  );
}
