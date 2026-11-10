import { readFileSync } from "node:fs";
import path from "node:path";

import {
  ACCENT_STORAGE_KEY,
  ACCENTS,
  applyAccent,
  applyAccentHeadings,
  HEADINGS_STORAGE_KEY,
  readAccentHeadings,
  type AccentId,
  readAccent,
  subscribeAccent,
  syncAccent,
} from "./accent";

const root = document.documentElement;
const webDir = process.cwd();

beforeEach(() => {
  localStorage.clear();
  delete root.dataset.accent;
  delete root.dataset.accentText;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("accent store (UX-12)", () => {
  it("offers Neutral first and nine more accents, with unique ids and names", () => {
    expect(ACCENTS[0]).toEqual({ id: "neutral", label: "Neutral" });
    expect(ACCENTS).toHaveLength(10);
    expect(new Set(ACCENTS.map((accent) => accent.id)).size).toBe(10);
    expect(new Set(ACCENTS.map((accent) => accent.label)).size).toBe(10);
  });

  it("defaults to Neutral and leaves <html> without data-accent", () => {
    expect(readAccent()).toBe("neutral");
    expect(root.dataset.accent).toBeUndefined();
  });

  it("stores and applies a choice, and applies it at once (no reload)", () => {
    applyAccent("teal");
    expect(localStorage.getItem(ACCENT_STORAGE_KEY)).toBe("teal");
    expect(root.dataset.accent).toBe("teal");
    expect(readAccent()).toBe("teal");
    applyAccent("pink");
    expect(root.dataset.accent).toBe("pink");
  });

  it("choosing Neutral clears the stored choice and the attribute", () => {
    applyAccent("red");
    applyAccent("neutral");
    expect(localStorage.getItem(ACCENT_STORAGE_KEY)).toBeNull();
    expect(root.dataset.accent).toBeUndefined();
    expect(readAccent()).toBe("neutral");
  });

  it("falls back to Neutral for an unknown stored value, and does not store an unknown choice", () => {
    localStorage.setItem(ACCENT_STORAGE_KEY, "chartreuse");
    expect(readAccent()).toBe("neutral");
    syncAccent();
    expect(root.dataset.accent).toBeUndefined();

    applyAccent("chartreuse" as AccentId);
    expect(localStorage.getItem(ACCENT_STORAGE_KEY)).toBe("chartreuse"); // untouched
    expect(root.dataset.accent).toBeUndefined();
  });

  it("syncAccent corrects a stale attribute from the stored choice", () => {
    root.dataset.accent = "red";
    syncAccent();
    expect(root.dataset.accent).toBeUndefined();
    localStorage.setItem(ACCENT_STORAGE_KEY, "green");
    syncAccent();
    expect(root.dataset.accent).toBe("green");
  });

  it("works without storage (private mode): the choice applies for this page view", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readAccent()).toBe("neutral");
    applyAccent("violet");
    expect(root.dataset.accent).toBe("violet");
    applyAccent("neutral");
    expect(root.dataset.accent).toBeUndefined();
  });

  it("notifies subscribers on a choice and on a change in another tab, until unsubscribed", () => {
    const callback = vi.fn();
    const unsubscribe = subscribeAccent(callback);
    applyAccent("blue");
    expect(callback).toHaveBeenCalledTimes(1);

    localStorage.setItem(ACCENT_STORAGE_KEY, "orange");
    window.dispatchEvent(new StorageEvent("storage", { key: ACCENT_STORAGE_KEY }));
    expect(callback).toHaveBeenCalledTimes(2);
    expect(root.dataset.accent).toBe("orange");

    window.dispatchEvent(new StorageEvent("storage", { key: "something-else" }));
    expect(callback).toHaveBeenCalledTimes(2);

    unsubscribe();
    applyAccent("green");
    expect(callback).toHaveBeenCalledTimes(2);
  });
});

describe("coloured headings (UX-12)", () => {
  it("are on by default, and only a non-neutral accent sets data-accent-text", () => {
    expect(readAccentHeadings()).toBe(true);
    applyAccent("blue");
    expect(root.dataset.accentText).toBe("on");
    applyAccent("neutral");
    expect(root.dataset.accentText).toBeUndefined();
  });

  it("turning them off stores 'off', removes the attribute at once and survives a new accent", () => {
    applyAccent("green");
    applyAccentHeadings(false);
    expect(localStorage.getItem(HEADINGS_STORAGE_KEY)).toBe("off");
    expect(readAccentHeadings()).toBe(false);
    expect(root.dataset.accentText).toBeUndefined();
    applyAccent("pink");
    expect(root.dataset.accentText).toBeUndefined();
    applyAccentHeadings(true);
    expect(localStorage.getItem(HEADINGS_STORAGE_KEY)).toBeNull();
    expect(root.dataset.accentText).toBe("on");
  });

  it("choosing while Neutral is remembered but sets nothing; an unknown stored value means on", () => {
    applyAccentHeadings(false);
    applyAccent("red");
    expect(root.dataset.accentText).toBeUndefined();
    localStorage.setItem(HEADINGS_STORAGE_KEY, "maybe");
    expect(readAccentHeadings()).toBe(true);
  });

  it("works without storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readAccentHeadings()).toBe(true);
    applyAccentHeadings(false);
    expect(readAccentHeadings()).toBe(true); // nothing could be stored
  });
});

describe("pre-paint script public/theme-init.js (accent)", () => {
  const source = readFileSync(path.join(webDir, "public", "theme-init.js"), "utf8");
  const run = () => new Function(source)();

  it("applies a stored accent and leaves Neutral alone", () => {
    localStorage.setItem(ACCENT_STORAGE_KEY, "amber");
    run();
    expect(root.dataset.accent).toBe("amber");

    delete root.dataset.accent;
    localStorage.removeItem(ACCENT_STORAGE_KEY);
    run();
    expect(root.dataset.accent).toBeUndefined();
  });

  it("sets data-accent-text with a stored accent unless headings were turned off", () => {
    localStorage.setItem(ACCENT_STORAGE_KEY, "teal");
    run();
    expect(root.dataset.accentText).toBe("on");
    delete root.dataset.accentText;
    localStorage.setItem(HEADINGS_STORAGE_KEY, "off");
    run();
    expect(root.dataset.accentText).toBeUndefined();
    expect(root.dataset.accent).toBe("teal");
    localStorage.removeItem(ACCENT_STORAGE_KEY);
    localStorage.removeItem(HEADINGS_STORAGE_KEY);
    delete root.dataset.accent;
    run();
    expect(root.dataset.accentText).toBeUndefined();
  });

  it("ignores a stored value that is not in the palette, and an explicit 'neutral'", () => {
    localStorage.setItem(ACCENT_STORAGE_KEY, '"><script>');
    run();
    expect(root.dataset.accent).toBeUndefined();
    localStorage.setItem(ACCENT_STORAGE_KEY, "neutral");
    run();
    expect(root.dataset.accent).toBeUndefined();
  });

  it("does not throw when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(run).not.toThrow();
    expect(root.dataset.accent).toBeUndefined();
  });

  it("knows exactly the palette of src/lib/accent.ts", () => {
    const listed = source.match(/var accents = \[([^\]]*)\]/)![1].match(/"([a-z]+)"/g)!.map((v) => v.slice(1, -1));
    expect(listed).toEqual(ACCENTS.map((accent) => accent.id).filter((id) => id !== "neutral"));
    expect(source).toContain(`"${ACCENT_STORAGE_KEY}"`);
  });
});
