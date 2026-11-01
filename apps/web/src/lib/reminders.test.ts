import {
  CUSTOM_TIMING_ID,
  MAX_DAYS_BEFORE,
  TIMING_PRESETS,
  describeTiming,
  presetById,
  presetIdFor,
  timingKey,
  validateTiming,
} from "./reminders";

describe("describeTiming", () => {
  it("describes no reminder", () => {
    expect(describeTiming(null)).toBe("No reminder");
  });

  it("describes the due day and multi-day leads", () => {
    expect(describeTiming({ days_before: 0, at_time: "09:00" })).toBe("On the due day at 09:00");
    expect(describeTiming({ days_before: 1, at_time: "08:15" })).toBe("1 day before at 08:15");
    expect(describeTiming({ days_before: 3, at_time: "18:00" })).toBe("3 days before at 18:00");
  });
});

describe("timingKey and presetIdFor", () => {
  it("matches a built-in preset", () => {
    expect(presetIdFor({ days_before: 1, at_time: "09:00" })).toBe("1d-9am");
  });

  it("reports off for no timing", () => {
    expect(presetIdFor(null)).toBe(TIMING_PRESETS[0].id);
  });

  it("falls back to custom for an unlisted timing", () => {
    expect(presetIdFor({ days_before: 3, at_time: "07:30" })).toBe(CUSTOM_TIMING_ID);
    expect(timingKey({ days_before: 3, at_time: "07:30" })).toBe("3d@07:30");
  });

  it("resolves a preset by id and omits unknown ones", () => {
    expect(presetById("off")?.timing).toBeNull();
    expect(presetById("nope")).toBeUndefined();
  });
});

describe("validateTiming", () => {
  it("accepts a valid custom timing", () => {
    expect(validateTiming(2, "07:45")).toEqual({
      ok: true,
      timing: { days_before: 2, at_time: "07:45" },
    });
    expect(validateTiming(MAX_DAYS_BEFORE, "23:59").ok).toBe(true);
  });

  it("rejects an out-of-range or non-integer day count", () => {
    expect(validateTiming(-1, "09:00").ok).toBe(false);
    expect(validateTiming(MAX_DAYS_BEFORE + 1, "09:00").ok).toBe(false);
    expect(validateTiming(1.5, "09:00").ok).toBe(false);
  });

  it("rejects a malformed time", () => {
    expect(validateTiming(1, "9:00").ok).toBe(false);
    expect(validateTiming(1, "24:00").ok).toBe(false);
    expect(validateTiming(1, "09:60").ok).toBe(false);
  });
});
