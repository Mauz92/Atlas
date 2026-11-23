import { applyPalette, PALETTE_STORAGE_KEY, readPalette, subscribePalette, syncPalette } from "./look";

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.palette;
});

describe("style palette", () => {
  it("is the neutral look by default and stores only an explicit Tavern choice", () => {
    expect(readPalette()).toBe("default");
    applyPalette("tavern");
    expect(readPalette()).toBe("tavern");
    expect(localStorage.getItem(PALETTE_STORAGE_KEY)).toBe("tavern");
    expect(document.documentElement.dataset.palette).toBe("tavern");
    applyPalette("default");
    expect(localStorage.getItem(PALETTE_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.dataset.palette).toBeUndefined();
  });

  it("ignores an unknown stored value and repairs a stale attribute", () => {
    localStorage.setItem(PALETTE_STORAGE_KEY, "neon");
    document.documentElement.dataset.palette = "neon";
    syncPalette();
    expect(readPalette()).toBe("default");
    expect(document.documentElement.dataset.palette).toBeUndefined();
  });

  it("tells subscribers about a change", () => {
    const seen = vi.fn();
    const stop = subscribePalette(seen);
    applyPalette("tavern");
    expect(seen).toHaveBeenCalledTimes(1);
    stop();
    applyPalette("default");
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
