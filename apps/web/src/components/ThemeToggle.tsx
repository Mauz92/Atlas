import { useSyncExternalStore } from "react";

import { readTheme, subscribeTheme, toggleTheme } from "../lib/theme";

/** Switches to the opposite of the theme shown now (an explicit choice; Settings offers System). */
export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, readTheme);

  return (
    <button
      type="button"
      className="ghost"
      onClick={toggleTheme}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
    >
      {theme === "dark" ? "Light" : "Dark"}
    </button>
  );
}
