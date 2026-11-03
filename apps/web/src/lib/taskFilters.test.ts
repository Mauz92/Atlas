import { makeTask } from "../test/tasks";
import { formatDay } from "./tasks";
import {
  DEFAULT_FILTER,
  chipValues,
  dueLabel,
  dueRangeFor,
  duePresetOf,
  isFiltered,
  filterFromParams,
  filterToParams,
  listOptionsFor,
  loadSavedFilters,
  SAVED_FILTERS_KEY,
  sortTasks,
  storeSavedFilters,
  type TaskFilter,
} from "./taskFilters";

describe("filter <-> URL", () => {
  it("writes only non-default fields and reads them back", () => {
    expect(filterToParams(DEFAULT_FILTER).toString()).toBe("");
    const filter: TaskFilter = {
      ...DEFAULT_FILTER,
      status: "completed",
      priority: "high",
      project: "p1",
      dueFrom: "2026-11-01",
      dueTo: "2026-11-30",
      q: "pay rent",
      sort: "title",
    };
    expect(filterFromParams(filterToParams(filter))).toEqual(filter);
  });

  it("falls back to the default sort for an unknown value", () => {
    expect(filterFromParams(new URLSearchParams("sort=bogus")).sort).toBe(
      "urgency",
    );
  });
});

describe("listOptionsFor", () => {
  it.each([
    ["open", ["inbox", "next", "in_progress"]],
    ["all", undefined],
    ["completed", "completed"],
  ])("maps status %s", (status, expected) => {
    expect(listOptionsFor({ ...DEFAULT_FILTER, status }).status).toEqual(
      expected,
    );
  });

  it("turns local dates into inclusive instants and passes junk through for the server to reject", () => {
    const options = listOptionsFor({
      ...DEFAULT_FILTER,
      dueFrom: "2026-11-01",
      dueTo: "not-a-date",
      q: "  rent ",
    });
    expect(options.dueFrom).toBe(new Date("2026-11-01T00:00:00").toISOString());
    expect(options.dueTo).toBe("not-a-date");
    expect(options.q).toBe("rent");
  });
});

describe("sortTasks", () => {
  const a = makeTask({ id: "a", title: "B", priority: "low", due_at: "2026-11-03T10:00:00Z", created_at: "2026-10-01T00:00:00Z" });
  const b = makeTask({ id: "b", title: "A", priority: "urgent", due_at: null, created_at: "2026-10-02T00:00:00Z" });
  const c = makeTask({ id: "c", title: "C", priority: "low", due_at: "2026-11-02T10:00:00Z", created_at: "2026-10-03T00:00:00Z" });

  it.each([
    ["urgency", "bca"],
    ["due", "cab"],
    ["newest", "cba"],
    ["title", "bac"],
  ] as const)("orders by %s", (sort, ids) => {
    expect(sortTasks([a, b, c], sort).map((t) => t.id).join("")).toBe(ids);
  });
});

describe("saved filters storage", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("round-trips, ignores corrupt or malformed data, and survives unavailable storage", () => {
    expect(storeSavedFilters([{ id: "1", name: "Mine", query: "q=x" }])).toBe(true);
    expect(loadSavedFilters()).toEqual([{ id: "1", name: "Mine", query: "q=x" }]);

    window.localStorage.setItem(SAVED_FILTERS_KEY, JSON.stringify([{ id: 1 }, "x"]));
    expect(loadSavedFilters()).toEqual([]);
    window.localStorage.setItem(SAVED_FILTERS_KEY, "{not json");
    expect(loadSavedFilters()).toEqual([]);

    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(loadSavedFilters()).toEqual([]);
    expect(storeSavedFilters([])).toBe(false);
  });
});

describe("view (list or board)", () => {
  it("is written only for the board and read back; anything else is the list", () => {
    expect(filterToParams({ ...DEFAULT_FILTER, view: "board" }).toString()).toBe("view=board");
    expect(filterFromParams(new URLSearchParams("view=board")).view).toBe("board");
    expect(filterFromParams(new URLSearchParams("view=gantt")).view).toBe("list");
    expect(isFiltered({ ...DEFAULT_FILTER, view: "board" })).toBe(false);
  });
});

describe("due presets", () => {
  // Wednesday 4 November 2026, local noon.
  const now = new Date(2026, 10, 4, 12);

  it("computes inclusive local ranges", () => {
    expect(dueRangeFor("any", now)).toEqual({ dueFrom: "", dueTo: "" });
    expect(dueRangeFor("overdue", now)).toEqual({ dueFrom: "", dueTo: "2026-11-03" });
    expect(dueRangeFor("today", now)).toEqual({ dueFrom: "2026-11-04", dueTo: "2026-11-04" });
    expect(dueRangeFor("week", now)).toEqual({ dueFrom: "2026-11-04", dueTo: "2026-11-10" });
  });

  it("crosses month and year ends", () => {
    expect(dueRangeFor("week", new Date(2026, 11, 29))).toEqual({
      dueFrom: "2026-12-29",
      dueTo: "2027-01-04",
    });
  });

  it("recognises a preset and labels any other range with formatted dates", () => {
    expect(duePresetOf(dueRangeFor("week", now), now)).toBe("week");
    expect(duePresetOf({ dueFrom: "2026-11-01", dueTo: "" }, now)).toBe("custom");
    expect(dueLabel({ dueFrom: "", dueTo: "" }, now)).toBe("");
    expect(dueLabel(dueRangeFor("today", now), now)).toBe("Today");
    const range = dueLabel({ dueFrom: "2026-11-01", dueTo: "2026-11-30" }, now);
    expect(range).toBe(`${formatDay("2026-11-01", now)} – ${formatDay("2026-11-30", now)}`);
    expect(range).not.toContain("2026-");
    expect(dueLabel({ dueFrom: "2026-11-01", dueTo: "" }, now)).toMatch(/^From /);
    expect(dueLabel({ dueFrom: "", dueTo: "2026-11-30" }, now)).toMatch(/^Until /);
  });
});

describe("chips", () => {
  it("shows values for set filters and nothing for unset ones", () => {
    const values = chipValues(
      { ...DEFAULT_FILTER, priority: "high", project: "p1", sort: "due" },
      (id) => (id === "p1" ? "Home" : undefined),
    );
    expect(values).toEqual({
      status: "Open",
      priority: "High",
      project: "Home",
      due: "",
      sort: "Due date",
    });
    expect(chipValues({ ...DEFAULT_FILTER, project: "gone" }, () => undefined).project).toBe(
      "Unknown project",
    );
  });

  it("reports whether anything but the default view is set", () => {
    expect(isFiltered(DEFAULT_FILTER)).toBe(false);
    expect(isFiltered({ ...DEFAULT_FILTER, q: "x" })).toBe(true);
    expect(isFiltered({ ...DEFAULT_FILTER, sort: "title" })).toBe(true);
  });
});
