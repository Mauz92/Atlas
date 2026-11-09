/**
 * @atlas/reminder-core - the framework-free device scheduler (M8-04b, ADR-0068).
 *
 * Public surface: the {@link Scheduler}, its ports and data types. Hosts (the Android plugin, the
 * desktop shell) inject a Clock, a NotificationPort, a SchedulerStore, a ReminderSource and an
 * ActionSink. Test doubles are in `@atlas/reminder-core/testing`.
 */
export { Scheduler, type SchedulerDeps } from "./scheduler.ts";
export { classify, effectiveOf, isLive, type PlantedBugs } from "./desired.ts";
export { contentFor, summaryContent, GENERIC_BODY, GENERIC_TITLE } from "./content.ts";
export { fireKey, hashKey } from "./ids.ts";
export { afterQuietHours, inQuietHours, localMinute } from "./quiet.ts";
export * from "./ports.ts";
export * from "./types.ts";
