import { makeTask } from "../test/tasks";
import { byDue, formatDay, groupToday, groupUpcomingByDay, priorityPillClass, sentenceCase } from "./tasks";

describe("groupToday", () => {
  it("splits overdue from due-today tasks", () => {
    const overdue = makeTask({ id: "o", title: "Late", due_state: "overdue" });
    const today = makeTask({ id: "t", title: "Now", due_state: "today" });
    const later = makeTask({ id: "u", title: "Later", due_state: "upcoming" });

    const groups = groupToday([today, overdue, later]);

    expect(groups.overdue.map((task) => task.id)).toEqual(["o"]);
    expect(groups.dueToday.map((task) => task.id)).toEqual(["t"]);
  });
});

describe("byDue", () => {
  it("orders tasks by their due instant", () => {
    const late = makeTask({ id: "late", due_at: "2026-10-28T09:00:00+00:00" });
    const early = makeTask({ id: "early", due_at: "2026-10-27T09:00:00+00:00" });

    expect(byDue([late, early]).map((task) => task.id)).toEqual(["early", "late"]);
  });
});

describe("groupUpcomingByDay", () => {
  it("groups tasks by the calendar day they fall on in the given zone", () => {
    const groups = groupUpcomingByDay(
      [
        makeTask({ id: "b", title: "B", due_at: "2026-10-28T09:00:00+00:00" }),
        makeTask({ id: "a", title: "A", due_at: "2026-10-27T09:00:00+00:00" }),
      ],
      "UTC",
    );

    expect(groups.map((group) => group.key)).toEqual(["2026-10-27", "2026-10-28"]);
    expect(groups[0].tasks.map((task) => task.title)).toEqual(["A"]);
    expect(groups[1].tasks.map((task) => task.title)).toEqual(["B"]);
  });
});

describe("priority and status display (UX-01)", () => {
  it("shows values in sentence case", () => {
    expect(sentenceCase("high")).toBe("High");
    expect(sentenceCase("on_hold")).toBe("On hold");
  });

  it("colours only the priorities that need attention", () => {
    expect(priorityPillClass("urgent")).toBe("pill pill-danger");
    expect(priorityPillClass("high")).toBe("pill pill-warning");
    expect(priorityPillClass("medium")).toBe("pill");
    expect(priorityPillClass("low")).toBe("pill pill-quiet");
  });
});

describe("formatDay", () => {
  const now = new Date(2026, 10, 4, 12);

  it("formats a calendar day without a zone shift, with the year only when it is not this year", () => {
    expect(formatDay("2026-11-04", now)).toBe(
      new Intl.DateTimeFormat(undefined, { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(
        new Date(Date.UTC(2026, 10, 4, 12)),
      ),
    );
    expect(formatDay("2026-11-04", now)).not.toContain("2026");
    expect(formatDay("2027-01-02", now)).toContain("2027");
    expect(formatDay("2026-11-04", now)).not.toMatch(/\d{4}-\d{2}/);
  });

  it("leaves unparseable text as it is", () => {
    expect(formatDay("soon", now)).toBe("soon");
  });
});
