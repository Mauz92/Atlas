import {
  NAV_ITEMS,
  NAV_SECTIONS,
  PALETTE_PAGES,
  RAIL_ITEMS,
  SECTIONS_STORAGE_KEY,
  activeNavKey,
  activeRail,
  defaultCollapsedSections,
  readCollapsedSections,
  readSidebarCollapsed,
  sectionsContaining,
  writeCollapsedSections,
  writeSidebarCollapsed,
} from "./navigation";

beforeEach(() => localStorage.clear());

describe("NAV_SECTIONS", () => {
  it("has at most six rail destinations, one per group", () => {
    expect(RAIL_ITEMS.map((item) => item.label)).toEqual([
      "Today",
      "Inbox",
      "Tasks",
      "Projects",
      "Notes",
      "Settings",
    ]);
    expect(RAIL_ITEMS.length).toBeLessThanOrEqual(6);
    expect(new Set(RAIL_ITEMS.map((item) => item.group)).size).toBe(RAIL_ITEMS.length);
  });

  it("lists every page once and keeps every former view reachable except Day", () => {
    const paths = NAV_ITEMS.map((item) => item.to);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.sort()).toEqual(
      [
        "/",
        "/inbox",
        "/upcoming",
        "/week",
        "/calendar",
        "/tasks",
        "/projects",
        "/notes",
        "/search",
        "/settings",
      ].sort(),
    );
  });

  it("every item belongs to a group the rail shows", () => {
    const groups = new Set(RAIL_ITEMS.map((item) => item.group));
    for (const item of NAV_ITEMS) {
      expect(groups.has(item.group)).toBe(true);
    }
  });
});

describe("palette pages", () => {
  it("offers the Calendar page, and Calendar accounts, Sync and Notifications as Settings sections", () => {
    const byLabel = Object.fromEntries(PALETTE_PAGES.map((page) => [page.label, page.to]));
    expect(byLabel).toMatchObject({
      Today: "/",
      Settings: "/settings",
      Calendar: "/calendar",
      "Calendar accounts": "/settings/calendar",
      Sync: "/settings/sync",
      Notifications: "/settings/notifications",
      "Data and backups": "/settings/data",
    });
    const targets = PALETTE_PAGES.map((page) => page.to);
    expect(new Set(targets).size).toBe(targets.length);
  });
});

describe("active state", () => {
  it.each([
    ["/", "/", "today"],
    ["/day", "/", "today"],
    ["/week/", "/week", "today"],
    ["/calendar", "/calendar", "today"],
    ["/projects/abc", "project:abc", "projects"],
    ["/projects/zzz", "/projects", "projects"],
    ["/sync", "/settings", "settings"],
    ["/settings/sync", "/settings", "settings"],
    ["/notifications", "/settings", "settings"],
    ["/nope", null, null],
  ])("%s → sidebar %s, rail %s", (path, key, rail) => {
    expect(activeNavKey(path, ["abc"])).toBe(key);
    expect(activeRail(path)).toBe(rail);
  });

  it("names the sections that must be open", () => {
    expect(sectionsContaining("/settings")).toEqual(["more"]);
    expect(sectionsContaining("project:abc")).toEqual(["workspace", "projects"]);
    expect(sectionsContaining(null)).toEqual([]);
  });
});

describe("shell preferences", () => {
  it("remembers the sidebar collapse", () => {
    expect(readSidebarCollapsed()).toBe(false);
    writeSidebarCollapsed(true);
    expect(readSidebarCollapsed()).toBe(true);
    writeSidebarCollapsed(false);
    expect(readSidebarCollapsed()).toBe(false);
  });

  it("remembers collapsed sections over the defaults and ignores junk", () => {
    expect(readCollapsedSections()).toEqual(defaultCollapsedSections());
    expect(defaultCollapsedSections().more).toBe(true);
    writeCollapsedSections({ ...defaultCollapsedSections(), planning: true, projects: true });
    expect(readCollapsedSections()).toMatchObject({ planning: true, projects: true, more: true });
    localStorage.setItem(SECTIONS_STORAGE_KEY, "{not json");
    expect(readCollapsedSections()).toEqual(defaultCollapsedSections());
    localStorage.setItem(SECTIONS_STORAGE_KEY, JSON.stringify({ more: "yes" }));
    expect(readCollapsedSections().more).toBe(true);
  });

  it("falls back to the defaults when storage throws", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      expect(readSidebarCollapsed()).toBe(false);
      expect(() => writeSidebarCollapsed(true)).not.toThrow();
      expect(readCollapsedSections()).toEqual(defaultCollapsedSections());
      expect(() => writeCollapsedSections({})).not.toThrow();
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });

  it("section ids are unique", () => {
    const ids = NAV_SECTIONS.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("projects");
  });
});
