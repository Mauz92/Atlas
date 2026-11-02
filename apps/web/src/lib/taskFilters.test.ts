import { makeTask } from "../test/tasks";
import {
  DEFAULT_FILTER,
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
