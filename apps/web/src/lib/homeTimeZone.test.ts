import { afterEach, describe, expect, it, vi } from "vitest";

import { browserTimeZone, ensureHomeTimeZone, listTimeZones } from "./homeTimeZone";

afterEach(() => vi.restoreAllMocks());

describe("browserTimeZone", () => {
  it("returns the engine's IANA zone", () => {
    expect(browserTimeZone()).toBe(new Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
  it("is null when the engine cannot tell", () => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(() => {
      throw new Error("no");
    });
    expect(browserTimeZone()).toBeNull();
  });
});

describe("listTimeZones", () => {
  it("is sorted, unique and always has the current value, UTC and the browser zone", () => {
    const list = listTimeZones("Mars/Olympus");
    expect(list).toContain("Mars/Olympus");
    expect(list).toContain("UTC");
    expect(list).toContain(browserTimeZone());
    expect(new Set(list).size).toBe(list.length);
    expect([...list].sort((a, b) => a.localeCompare(b))).toEqual(list);
  });
});

describe("ensureHomeTimeZone (first sign-in)", () => {
  it("adopts the browser zone when none is set", async () => {
    const set = vi.fn(async (zone: string | null) => ({ time_zone: zone }));
    const out = await ensureHomeTimeZone({ get: async () => ({ time_zone: null }), set });
    expect(set).toHaveBeenCalledWith(browserTimeZone());
    expect(out).toBe(browserTimeZone());
  });
  it("never overwrites an existing zone", async () => {
    const set = vi.fn();
    const out = await ensureHomeTimeZone({ get: async () => ({ time_zone: "Asia/Tokyo" }), set });
    expect(set).not.toHaveBeenCalled();
    expect(out).toBeNull();
  });
});
