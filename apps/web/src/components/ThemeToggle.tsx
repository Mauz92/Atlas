import { useEffect, useSyncExternalStore } from "react";

import { readTheme, subscribeTheme, toggleTheme } from "../lib/theme";

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, readTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

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
