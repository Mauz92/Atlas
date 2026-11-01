import { makeProject, makeTask } from "../test/tasks";
import {
  addDays,
  dayKeyOf,
  dayWindow,
  indexProjects,
  projectsForTasks,
  startOfDay,
  startOfWeek,
  tasksForDay,
  weekDates,
  weekDayGroups,
  weekWindow,
} from "./planning";

// 2026-10-26 is a Monday; every anchor below is noon UTC so its calendar date is the same in any
// machine zone between UTC-11 and UTC+11, which keeps these tests deterministic everywhere.
const MONDAY = new Date("2026-10-26T12:00:00Z");

describe("startOfDay / addDays / startOfWeek", () => {
  it("returns local midnight and shifts by whole calendar days", () => {
    const start = startOfDay(MONDAY);
    expect([start.getHours(), start.getMinutes(), start.getSeconds(), start.getMilliseconds()]).toEqual(
      [0, 0, 0, 0],
    );
    expect(dayKeyOf(addDays(start, 1))).toBe("2026-10-27");
    // Across a month and a year boundary.
    expect(dayKeyOf(addDays(startOfDay(new Date("2026-12-31T12:00:00Z")), 1))).toBe("2027-01-01");
  });

  it("starts the week on Monday for any day of the week", () => {
    for (let offset = 0; offset < 7; offset += 1) {
      expect(dayKeyOf(startOfWeek(addDays(startOfDay(MONDAY), offset)))).toBe("2026-10-26");
    }
  });
});

describe("weekDates", () => {
  it("returns the seven local days, Monday first", () => {
    const keys = weekDates(startOfWeek(MONDAY)).map((date) => dayKeyOf(date));
    expect(keys).toEqual([
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
    ]);
  });
});

describe("dayWindow / weekWindow", () => {
  it("spans exactly one local day: its midnight to the next", () => {
    const window = dayWindow(MONDAY);
    expect(dayKeyOf(new Date(window.dueFrom))).toBe("2026-10-26");
    expect(dayKeyOf(new Date(window.dueTo))).toBe("2026-10-27");
    expect(new Date(window.dueFrom).getTime()).toBeLessThan(new Date(window.dueTo).getTime());
  });

  it("spans exactly the seven local days of the week", () => {
    const window = weekWindow(startOfWeek(MONDAY));
    expect(dayKeyOf(new Date(window.dueFrom))).toBe("2026-10-26");
    expect(dayKeyOf(new Date(window.dueTo))).toBe("2026-11-02");
    // Every day of the week falls inside the window.
    for (const date of weekDates(startOfWeek(MONDAY))) {
      const instant = date.getTime();
      expect(instant).toBeGreaterThanOrEqual(new Date(window.dueFrom).getTime());
      expect(instant).toBeLessThanOrEqual(new Date(window.dueTo).getTime());
    }
  });

  it("expresses the window as UTC instants, whatever the viewer zone", () => {
    // The API parses a full instant exactly and converts the offset to UTC (filters.parse_instant).
    expect(dayWindow(MONDAY).dueFrom).toMatch(/Z$/);
    expect(weekWindow(startOfWeek(MONDAY)).dueTo).toMatch(/Z$/);
  });
});

describe("tasksForDay", () => {
  it("keeps the tasks due on the given local day, soonest first, and drops undated ones", () => {
    const morning = makeTask({ id: "m", due_at: "2026-10-26T09:00:00Z" });
    const evening = makeTask({ id: "e", due_at: "2026-10-26T18:00:00Z" });
    const otherDay = makeTask({ id: "o", due_at: "2026-10-27T09:00:00Z" });
    const undated = makeTask({ id: "u", due_at: null });

    const result = tasksForDay([evening, otherDay, undated, morning], MONDAY, "UTC");

    expect(result.map((task) => task.id)).toEqual(["m", "e"]);
  });

  it("places a UTC instant on the viewer's local day, not the UTC one", () => {
    // 23:30 UTC on the 26th is already the 27th in Berlin (UTC+1 in late October).
    const lateEvening = makeTask({ id: "late", due_at: "2026-10-26T23:30:00Z" });

    expect(tasksForDay([lateEvening], MONDAY, "Europe/Berlin")).toEqual([]);
    expect(
      tasksForDay([lateEvening], new Date("2026-10-27T12:00:00Z"), "Europe/Berlin").map((t) => t.id),
    ).toEqual(["late"]);
  });
});

describe("weekDayGroups", () => {
  it("always renders the seven local days, in order, including empty ones", () => {
    const groups = weekDayGroups([], startOfWeek(MONDAY));

    expect(groups).toHaveLength(7);
    expect(groups.map((group) => group.key)).toEqual([
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
    ]);
    expect(groups.every((group) => group.tasks.length === 0)).toBe(true);
    expect(groups[0].label).toMatch(/26/);
  });

  it("places each task on its own day, and never places an undated task", () => {
    const weekStart = startOfWeek(MONDAY);
    const tuesday = addDays(weekStart, 1);
    const friday = addDays(weekStart, 4);
    const atNine = (date: Date) => new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString();

    const groups = weekDayGroups(
      [
        makeTask({ id: "fri", due_at: atNine(friday) }),
        makeTask({ id: "tue", due_at: atNine(tuesday) }),
        makeTask({ id: "none", due_at: null }),
      ],
      weekStart,
    );
    const byKey = new Map(groups.map((group) => [group.key, group.tasks.map((task) => task.id)]));

    expect(byKey.get(dayKeyOf(tuesday))).toEqual(["tue"]);
    expect(byKey.get(dayKeyOf(friday))).toEqual(["fri"]);
    expect(groups.flatMap((group) => group.tasks)).toHaveLength(2);
  });
});

describe("projectsForTasks / indexProjects", () => {
  it("lists the distinct projects a plan touches, in first-seen order", () => {
    const alpha = makeProject({ id: "p1", name: "Alpha" });
    const beta = makeProject({ id: "p2", name: "Beta" });
    const lookup = indexProjects([alpha, beta]);

    const tasks = [
      makeTask({ id: "a", project_id: "p1" }),
      makeTask({ id: "b", project_id: "p2" }),
      makeTask({ id: "c", project_id: "p1" }),
      makeTask({ id: "d", project_id: null }),
      makeTask({ id: "e", project_id: "gone" }),
    ];

    expect(projectsForTasks(tasks, lookup).map((project) => project.name)).toEqual(["Alpha", "Beta"]);
    expect(projectsForTasks([makeTask({ id: "x", project_id: null })], lookup)).toEqual([]);
  });
});
