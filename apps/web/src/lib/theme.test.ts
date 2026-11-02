import { readFileSync } from "node:fs";
import path from "node:path";

import {
  applyTheme,
  readTheme,
  readThemePreference,
  subscribeTheme,
  THEME_STORAGE_KEY,
  toggleTheme,
} from "./theme";

/** A controllable `prefers-color-scheme: dark` media query (jsdom has no matchMedia). */
function mockSystem(initiallyDark: boolean) {
  let dark = initiallyDark;
  const listeners = new Set<() => void>();
  const query = {
    get matches() {
      return dark;
    },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal("matchMedia", vi.fn(() => query));
  return {
    set(value: boolean) {
      dark = value;
      listeners.forEach((listener) => listener());
    },
    listeners,
  };
}

const root = document.documentElement;
// Vitest runs from apps/web (jsdom gives import.meta.url a non-file scheme).
const webDir = process.cwd();

beforeEach(() => {
  localStorage.clear();
  delete root.dataset.theme;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("theme store (System / Light / Dark)", () => {
  it("defaults to System, which follows the OS and leaves <html> without data-theme", () => {
    const system = mockSystem(true);
    expect(readThemePreference()).toBe("system");
    expect(readTheme()).toBe("dark");
    system.set(false);
    expect(readTheme()).toBe("light");
    expect(root.dataset.theme).toBeUndefined();
  });

  it("stores and applies an explicit Light or Dark choice", () => {
    mockSystem(true);
    applyTheme("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(root.dataset.theme).toBe("light");
    expect(readThemePreference()).toBe("light");
    expect(readTheme()).toBe("light");

    applyTheme("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(root.dataset.theme).toBe("dark");
    expect(readTheme()).toBe("dark");
  });

  it("choosing System clears the stored choice and the attribute", () => {
    mockSystem(false);
    applyTheme("dark");
    applyTheme("system");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(root.dataset.theme).toBeUndefined();
    expect(readThemePreference()).toBe("system");
    expect(readTheme()).toBe("light");
  });

  it("ignores an unknown stored value", () => {
    mockSystem(false);
    localStorage.setItem(THEME_STORAGE_KEY, "sepia");
    expect(readThemePreference()).toBe("system");
  });

  it("toggle switches to the opposite of what is shown, as an explicit choice", () => {
    mockSystem(true);
    toggleTheme();
    expect(readThemePreference()).toBe("light");
    expect(root.dataset.theme).toBe("light");
    toggleTheme();
    expect(readThemePreference()).toBe("dark");
  });

  it("notifies subscribers on a choice and on an OS theme change, until unsubscribed", () => {
    const system = mockSystem(false);
    const callback = vi.fn();
    const unsubscribe = subscribeTheme(callback);
    applyTheme("dark");
    expect(callback).toHaveBeenCalledTimes(1);
    system.set(true);
    expect(callback).toHaveBeenCalledTimes(2);
    unsubscribe();
    expect(system.listeners.size).toBe(0);
    applyTheme("light");
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("works without storage (private mode)", () => {
    mockSystem(true);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readTheme()).toBe("dark");
    applyTheme("light");
    expect(root.dataset.theme).toBe("light");
    vi.restoreAllMocks();
  });
});

describe("pre-paint script public/theme-init.js", () => {
  const source = readFileSync(path.join(webDir, "public", "theme-init.js"), "utf8");
  const run = () => new Function(source)();

  it("applies a stored choice and leaves System alone", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    run();
    expect(root.dataset.theme).toBe("dark");

    delete root.dataset.theme;
    localStorage.removeItem(THEME_STORAGE_KEY);
    run();
    expect(root.dataset.theme).toBeUndefined();

    localStorage.setItem(THEME_STORAGE_KEY, "<script>");
    run();
    expect(root.dataset.theme).toBeUndefined();
  });

  it("is loaded from index.html as a same-origin file before the app (no inline script, CSP-safe)", () => {
    const html = readFileSync(path.join(webDir, "index.html"), "utf8");
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).toContain('<script src="/theme-init.js"></script>');
    // Every script element has a src: nothing inline that `script-src 'self'` would block.
    expect(html.match(/<script(?![^>]*\bsrc=)[^>]*>/g)).toBeNull();
  });
});
