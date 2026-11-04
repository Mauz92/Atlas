import { dueChip } from "./dueChip";

const base = { status: "next", time_zone: "UTC" as string | null };

describe("dueChip", () => {
  it("returns nothing without a due date", () => {
    expect(dueChip({ ...base, due_at: null, due_state: "none" }, "UTC")).toBeNull();
  });

  it("marks overdue and due-today by state, using the server's classification", () => {
    expect(dueChip({ ...base, due_at: "2026-11-01T23:59:00Z", due_state: "overdue" }, "UTC")).toEqual({
      kind: "overdue",
      text: expect.stringMatching(/1/),
    });
    expect(dueChip({ ...base, due_at: "2026-11-03T15:00:00Z", due_state: "today" }, "UTC")).toEqual({
      kind: "today",
      // "15:00" in a 24-hour locale, "03:00 PM" in en-US (the CI runner): same instant, locale-dependent text.
      text: expect.stringMatching(/15|0?3:00/),
    });
  });

  it("lets a date-only due today say only 'Today' (empty text)", () => {
    expect(dueChip({ ...base, due_at: "2026-11-03T23:59:00Z", due_state: "today" }, "UTC")).toEqual({
      kind: "today",
      text: "",
    });
  });

  it("does not call a completed task overdue or due today", () => {
    expect(
      dueChip({ ...base, status: "completed", due_at: "2026-11-01T23:59:00Z", due_state: "overdue" }, "UTC")?.kind,
    ).toBe("later");
  });

  it("inside a day group keeps only the time, and omits a date-only later chip", () => {
    const timed = dueChip({ ...base, due_at: "2026-11-08T09:30:00Z", due_state: "upcoming" }, "UTC", "2026-11-08");
    expect(timed?.kind).toBe("later");
    expect(timed?.text).toMatch(/09:30|9:30/);
    expect(timed?.text).not.toMatch(/Nov/);
    expect(dueChip({ ...base, due_at: "2026-11-08T23:59:00Z", due_state: "upcoming" }, "UTC", "2026-11-08")).toBeNull();
  });

  it("shows the full date when the due is not on the group's day (an overdue row in Today)", () => {
    const chip = dueChip({ ...base, due_at: "2026-10-29T23:59:00Z", due_state: "overdue" }, "UTC", "2026-11-03");
    expect(chip?.kind).toBe("overdue");
    expect(chip?.text).toMatch(/29/);
  });
});
