import { makeTask } from "../test/tasks";
import {
  changesFromDraft,
  draftFromTask,
  draftsEqual,
  dueOn,
  localDate,
  parseTags,
  recurrenceAnchor,
  repeatChoice,
  scheduleDate,
  scheduleFields,
} from "./taskForm";
import { formatDue, wallClock } from "./tasks";

describe("wallClock", () => {
  it("renders an instant as the wall clock of the given zone", () => {
    expect(wallClock("2026-11-02T23:30:00Z", "Asia/Tokyo")).toEqual({
      date: "2026-11-03",
      time: "08:30",
    });
    expect(wallClock("2026-11-02T23:30:00Z", "UTC")).toEqual({
      date: "2026-11-02",
      time: "23:30",
    });
  });

  it("falls back to the viewer's zone for a zone the platform does not know", () => {
    expect(wallClock("2026-11-02T10:00:00Z", "Not/AZone").date).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });
});

describe("localDate / dueOn", () => {
  it("adds calendar days without a DST shift", () => {
    const now = new Date("2026-03-28T12:00:00Z");
    expect(localDate(0, "Europe/Stockholm", now)).toBe("2026-03-28");
    expect(localDate(1, "Europe/Stockholm", now)).toBe("2026-03-29");
    expect(localDate(2, "Europe/Stockholm", now)).toBe("2026-03-30");
  });

  it("sends a date-only due as naive end of day plus the zone, leaving conversion to the server", () => {
    expect(dueOn("2026-11-03", "Europe/Stockholm")).toEqual({
      due_at: "2026-11-03T23:59:00",
      time_zone: "Europe/Stockholm",
    });
    expect(dueOn("2026-11-03", undefined)).toEqual({
      due_at: "2026-11-03T23:59:00",
    });
  });
});

describe("scheduleDate / scheduleFields (UX-03 quick actions)", () => {
  // Sunday 2026-11-01 13:00 in Stockholm.
  const now = new Date("2026-11-01T12:00:00Z");
  const zone = "Europe/Stockholm";

  it.each([
    ["today", "2026-11-01"],
    ["tomorrow", "2026-11-02"],
    ["next-week", "2026-11-02"], // the coming Monday
    [{ date: "2031-03-04" }, "2031-03-04"],
  ] as const)("%j is %s", (when, date) => {
    expect(scheduleDate(when, zone, now)).toBe(date);
  });

  it("next week from a Monday is the Monday after", () => {
    expect(scheduleDate("next-week", zone, new Date("2026-11-02T12:00:00Z"))).toBe("2026-11-09");
  });

  it.each([
    ["an inbox task gets a date-only due and is triaged to next", { status: "inbox" }, {
      status: "next",
      due_at: "2026-11-02T23:59:00",
      time_zone: zone,
    }],
    ["a timed task keeps its clock time in its own zone", {
      status: "next",
      due_at: "2026-10-30T14:00:00Z",
      time_zone: "UTC",
    }, { due_at: "2026-11-02T14:00:00", time_zone: "UTC" }],
  ])("%s", (_, task, expected) => {
    expect(scheduleFields(makeTask(task), "tomorrow", zone, now)).toEqual(expected);
  });

  it("clears the due date without changing the status", () => {
    expect(scheduleFields(makeTask({ status: "inbox" }), null, zone, now)).toEqual({ due_at: null });
  });
});

describe("draftFromTask / changesFromDraft", () => {
  const task = makeTask({
    title: "Pay rent",
    description: "Landlord",
    due_at: "2026-11-03T22:59:00Z", // 23:59 in Stockholm (CET)
    time_zone: "Europe/Stockholm",
    tags: ["home", "money"],
  });

  it("shows a date-only due with an empty time and round-trips unchanged", () => {
    const draft = draftFromTask(task, "UTC");
    expect(draft).toMatchObject({
      dueDate: "2026-11-03",
      dueTime: "",
      timeZone: "Europe/Stockholm",
      tags: "home, money",
    });
    expect(changesFromDraft(draft, { ...draft }, "UTC")).toEqual({});
    expect(draftsEqual(draft, { ...draft })).toBe(true);
  });

  it("sends only the changed fields", () => {
    const initial = draftFromTask(task, "UTC");
    expect(
      changesFromDraft(
        initial,
        { ...initial, title: "Pay rent now", priority: "high" },
        "UTC",
      ),
    ).toEqual({
      title: "Pay rent now",
      priority: "high",
    });
  });

  it("clears nullable fields with null and sends cleared tags as an empty list", () => {
    const initial = draftFromTask(task, "UTC");
    expect(
      changesFromDraft(
        initial,
        { ...initial, description: " ", dueDate: "", tags: "" },
        "UTC",
      ),
    ).toEqual({ description: null, due_at: null, tags: [] });
  });

  it("sends date, time and the viewer's zone together when a zoneless task is given a due time", () => {
    const zoneless = draftFromTask(
      makeTask({ time_zone: null }),
      "Europe/Stockholm",
    );
    expect(
      changesFromDraft(
        zoneless,
        { ...zoneless, dueDate: "2026-11-05", dueTime: "09:30" },
        "Europe/Stockholm",
      ),
    ).toEqual({ due_at: "2026-11-05T09:30:00", time_zone: "Europe/Stockholm" });
  });

  it("re-sends the due wall clock when only the zone changes, so the server re-interprets it", () => {
    const initial = draftFromTask(task, "UTC");
    expect(
      changesFromDraft(initial, { ...initial, timeZone: "Asia/Tokyo" }, "UTC"),
    ).toEqual({
      time_zone: "Asia/Tokyo",
      due_at: "2026-11-03T23:59:00",
    });
  });

  it("sends a start as a naive wall clock", () => {
    const initial = draftFromTask(task, "UTC");
    expect(
      changesFromDraft(
        initial,
        { ...initial, start: "2026-11-02T08:00" },
        "UTC",
      ),
    ).toEqual({
      start_at: "2026-11-02T08:00:00",
    });
  });
});

describe("parseTags", () => {
  it("splits on commas and drops blanks", () => {
    expect(parseTags(" a, b ,, c ")).toEqual(["a", "b", "c"]);
    expect(parseTags("")).toEqual([]);
  });
});

describe("formatDue", () => {
  it("omits the clock time for a date-only (end of day) due", () => {
    const dateOnly = formatDue("2026-11-03T22:59:00Z", "Europe/Stockholm");
    const timed = formatDue("2026-11-03T09:30:00Z", "Europe/Stockholm");
    expect(dateOnly).not.toMatch(/\d:\d\d/);
    expect(timed).toMatch(/\d:\d\d/);
  });
});

describe("recurrence in the form", () => {
  const base = draftFromTask(
    makeTask({ due_at: "2026-11-03T09:30:00Z", time_zone: "UTC" }),
    "UTC",
  );

  it.each([
    ["FREQ=DAILY", "daily"],
    ["FREQ=MONTHLY", "monthly"],
    ["FREQ=WEEKLY;BYDAY=MO,WE", "custom"],
    ["", ""],
  ])("classifies %j as %j", (rule, choice) => {
    expect(repeatChoice(rule)).toBe(choice);
  });

  it("sends only the rule (null clears it) and prefers the due date as the anchor", () => {
    const set = { ...base, recurrenceRule: " FREQ=DAILY " };
    expect(changesFromDraft(base, set, "UTC")).toEqual({
      recurrence_rule: "FREQ=DAILY",
    });
    const repeating = { ...base, recurrenceRule: "FREQ=DAILY" };
    expect(
      changesFromDraft(repeating, { ...repeating, recurrenceRule: "" }, "UTC"),
    ).toEqual({
      recurrence_rule: null,
    });
    expect(recurrenceAnchor({ ...base, start: "2026-11-01T08:00" })).toBe(
      "2026-11-03T09:30:00",
    );
    expect(
      recurrenceAnchor({
        ...base,
        dueDate: "",
        dueTime: "",
        start: "2026-11-01T08:00",
      }),
    ).toBe("2026-11-01T08:00:00");
    expect(recurrenceAnchor({ ...base, dueDate: "", dueTime: "" })).toBeNull();
  });

  it("pins the viewer's zone when a task without one starts repeating", () => {
    const noZone = draftFromTask(
      makeTask({ due_at: "2026-11-03T09:30:00Z" }),
      "Europe/Stockholm",
    );
    expect(
      changesFromDraft(
        noZone,
        { ...noZone, recurrenceRule: "FREQ=DAILY" },
        "Europe/Stockholm",
      ),
    ).toEqual({ recurrence_rule: "FREQ=DAILY", time_zone: "Europe/Stockholm" });
  });
});
