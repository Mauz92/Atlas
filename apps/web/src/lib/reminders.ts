/**
 * Reminder timing vocabulary and rules (M8-05).
 *
 * Everything that decides *what* the reminder-timing surface offers and *whether* a chosen value is
 * valid lives here, so the page, the hook and the presentational component stay thin (AGENTS.md §6).
 * The timing is the M8-01 policy shape — whole `days_before` days before the due date, at a 24-hour
 * `at_time` local wall-clock — and the server re-validates it; this is only the client-side mirror
 * (AGENTS.md §7.4: client validation improves usability, it does not replace server validation).
 */

import type { ReminderTiming } from "../api/client";

/** The largest whole-day lead the server accepts (`MAX_DAYS_BEFORE`); mirrored here for the UI. */
export const MAX_DAYS_BEFORE = 30;

/** The value the timing `<select>` uses for the "choose your own" option. */
export const CUSTOM_TIMING_ID = "custom";

/** One selectable reminder timing. `timing === null` means reminders are off. */
export interface TimingPreset {
  id: string;
  label: string;
  timing: ReminderTiming | null;
}

/** The built-in timings, in the order the preferences surface offers them. */
export const TIMING_PRESETS: readonly TimingPreset[] = [
  { id: "off", label: "No reminder", timing: null },
  {
    id: "due-9am",
    label: "On the due day at 09:00",
    timing: { days_before: 0, at_time: "09:00" },
  },
  { id: "1d-9am", label: "1 day before at 09:00", timing: { days_before: 1, at_time: "09:00" } },
  { id: "2d-9am", label: "2 days before at 09:00", timing: { days_before: 2, at_time: "09:00" } },
  { id: "1w-9am", label: "1 week before at 09:00", timing: { days_before: 7, at_time: "09:00" } },
];

/** `HH:MM`, 24-hour — the only `at_time` shape the server accepts. */
const AT_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Human text for a timing (or "No reminder" for none). */
export function describeTiming(timing: ReminderTiming | null): string {
  if (timing === null) {
    return "No reminder";
  }
  if (timing.days_before === 0) {
    return `On the due day at ${timing.at_time}`;
  }
  if (timing.days_before === 1) {
    return `1 day before at ${timing.at_time}`;
  }
  return `${timing.days_before} days before at ${timing.at_time}`;
}

/** Stable identity for a timing, so the select can match it to a preset. */
export function timingKey(timing: ReminderTiming): string {
  return `${timing.days_before}d@${timing.at_time}`;
}

/** The preset id that matches `timing`, or {@link CUSTOM_TIMING_ID} when none does. */
export function presetIdFor(timing: ReminderTiming | null): string {
  const match = TIMING_PRESETS.find(
    (preset) => preset.timing !== null && timing !== null && timingKey(preset.timing) === timingKey(timing),
  );
  if (match) {
    return match.id;
  }
  if (timing === null) {
    return TIMING_PRESETS[0].id;
  }
  return CUSTOM_TIMING_ID;
}

/** The preset for an id, or `undefined` when the id is unknown. */
export function presetById(id: string): TimingPreset | undefined {
  return TIMING_PRESETS.find((preset) => preset.id === id);
}

/** The result of validating a custom timing: either a timing or a human error message. */
export type TimingValidation =
  | { ok: true; timing: ReminderTiming }
  | { ok: false; error: string };

/**
 * Validate a custom timing typed into the surface. Mirrors the server's boundary rules: a whole
 * number of days between 0 and {@link MAX_DAYS_BEFORE}, and a 24-hour `HH:MM` time.
 */
export function validateTiming(daysBefore: number, atTime: string): TimingValidation {
  if (!Number.isInteger(daysBefore) || daysBefore < 0 || daysBefore > MAX_DAYS_BEFORE) {
    return { ok: false, error: `Days before must be a whole number between 0 and ${MAX_DAYS_BEFORE}.` };
  }
  if (!AT_TIME_PATTERN.test(atTime)) {
    return { ok: false, error: "Time must be a 24-hour HH:MM value, for example 09:00." };
  }
  return { ok: true, timing: { days_before: daysBefore, at_time: atTime } };
}
