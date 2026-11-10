import { describe, expect, it } from "vitest";

import type { CalendarEvent } from "../api/client";
import {
  addMonthsKey,
  connectResultMessage,
  dayKeyIn,
  layoutOverlaps,
  otherZoneNote,
  segmentsByDay,
  startOfDayIn,
  stepAnchor,
  viewRange,
  weekStartKey,
} from "./calendar";

function event(overrides: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: "e1", occurrence: null, source_id: "s1", provider: "ics", title: "Event",
    start: "2026-11-10T09:00:00Z", end: "2026-11-10T10:00:00Z", time_zone: "UTC",
    is_all_day: false, start_date: null, end_date: null, status: "confirmed", is_recurring: false, location: null,
    ...overrides,
  };
}

describe("days and zones", () => {
  it("finds local midnight across a DST change", () => {
    // Berlin: CEST (+2) until 2026-10-25 03:00, CET (+1) after.
    expect(startOfDayIn("2026-10-24", "Europe/Berlin").toISOString()).toBe("2026-10-23T22:00:00.000Z");
    expect(startOfDayIn("2026-10-26", "Europe/Berlin").toISOString()).toBe("2026-10-25T23:00:00.000Z");
    expect(startOfDayIn("2026-10-25", "Europe/Berlin").toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(startOfDayIn("2026-11-10", "America/New_York").toISOString()).toBe("2026-11-10T05:00:00.000Z");
  });

  it("puts an instant on the viewer's local day", () => {
    expect(dayKeyIn("2026-11-10T23:30:00Z", "Europe/Berlin")).toBe("2026-11-11");
    expect(dayKeyIn("2026-11-10T23:30:00Z", "America/Los_Angeles")).toBe("2026-11-10");
  });

  it("starts weeks on Monday and clamps month steps", () => {
    expect(weekStartKey("2026-11-10")).toBe("2026-11-09");
    expect(weekStartKey("2026-11-15")).toBe("2026-11-09");
    expect(addMonthsKey("2026-01-31", 1)).toBe("2026-02-28");
    expect(stepAnchor("month", "2026-01-31", -1)).toBe("2025-12-01");
  });

  it("builds whole-week month grids", () => {
    const range = viewRange("month", "2026-11-10", "Europe/Berlin");
    expect(range.days[0]).toBe("2026-10-26");
    expect(range.days.length % 7).toBe(0);
    expect(range.days[range.days.length - 1]).toBe("2026-12-06");
  });
});

describe("segments", () => {
  it("shows an all-day event on the same dates in every zone", () => {
    const trip = event({ is_all_day: true, start_date: "2026-11-24", end_date: "2026-11-27", start: "2026-11-23T23:00:00Z", end: "2026-11-26T23:00:00Z", time_zone: "Europe/Berlin" });
    for (const zone of ["Europe/Berlin", "Pacific/Auckland", "America/Los_Angeles"]) {
      const days = ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27"];
      const map = segmentsByDay([trip], days, zone);
      expect([...map].filter(([, s]) => s.length).map(([d]) => d)).toEqual(["2026-11-24", "2026-11-25", "2026-11-26"]);
    }
  });

  it("splits a timed event that crosses midnight", () => {
    const late = event({ start: "2026-11-10T21:00:00Z", end: "2026-11-11T02:00:00Z", time_zone: "UTC" });
    const map = segmentsByDay([late], ["2026-11-10", "2026-11-11"], "UTC");
    expect(map.get("2026-11-10")![0]).toMatchObject({ startMin: 1260, endMin: 1440, continuesAfter: true });
    expect(map.get("2026-11-11")![0]).toMatchObject({ startMin: 0, endMin: 120, continuesBefore: true });
  });

  it("places an event in the viewer's zone, not the event's", () => {
    const e = event({ start: "2026-11-10T23:30:00Z", end: "2026-11-11T00:30:00Z", time_zone: "UTC" });
    const berlin = segmentsByDay([e], ["2026-11-10", "2026-11-11"], "Europe/Berlin");
    expect(berlin.get("2026-11-10")!.length).toBe(0);
    expect(berlin.get("2026-11-11")![0].startMin).toBe(30);
  });

  it("gives zero-length events a visible height", () => {
    const e = event({ start: "2026-11-10T09:00:00Z", end: "2026-11-10T09:00:00Z" });
    const segment = segmentsByDay([e], ["2026-11-10"], "UTC").get("2026-11-10")![0];
    expect(segment.endMin - segment.startMin).toBeGreaterThanOrEqual(15);
  });
});

describe("overlap layout", () => {
  const seg = (id: string, startMin: number, endMin: number) => ({
    event: event({ id }), day: "d", allDay: false, startMin, endMin, continuesBefore: false, continuesAfter: false,
  });

  it("puts overlapping events side by side and reuses columns", () => {
    const placed = layoutOverlaps([seg("a", 540, 600), seg("b", 560, 640), seg("c", 600, 660), seg("d", 700, 760)]);
    const by = Object.fromEntries(placed.map((p) => [p.segment.event.id, p]));
    expect(by.a).toMatchObject({ column: 0, columns: 2 });
    expect(by.b).toMatchObject({ column: 1, columns: 2 });
    expect(by.c).toMatchObject({ column: 0, columns: 2 });
    expect(by.d).toMatchObject({ column: 0, columns: 1 });
  });
});

describe("text", () => {
  it("notes another zone only when it differs", () => {
    const e = event({ time_zone: "Europe/Berlin" });
    expect(otherZoneNote(e, "Europe/Berlin")).toBeNull();
    expect(otherZoneNote(e, "America/New_York")).toContain("Europe/Berlin");
    expect(otherZoneNote(event({ is_all_day: true, time_zone: "Europe/Berlin" }), "America/New_York")).toBeNull();
  });

  it("explains every connect result safely", () => {
    expect(connectResultMessage("connected", "google").ok).toBe(true);
    for (const code of ["access_denied", "insufficient_scope", "no_refresh_token", "state_used", "weird"]) {
      expect(connectResultMessage(code, "google").ok).toBe(false);
    }
  });
});
