/**
 * @atlas/desktop-core: the framework-neutral core of the Atlas desktop client (SYNC-09, ADR-0069).
 * Hosts implement {@link PlatformPort}; see `docs/ARCHITECTURE.md` section 8a.
 */
export * from "./ports.ts";
export { SqliteLocalStore } from "./sqliteStore.ts";
export { NotesFolderSync } from "./notes/sync.ts";
export type { IndexEntry, NotesEngine, NotesSyncReport, SkippedFile, SkipReason } from "./notes/sync.ts";
export { DesktopRuntime } from "./runtime.ts";
export type { RuntimeOptions, RuntimePhase, RuntimeSnapshot } from "./runtime.ts";
export { LiveConnection } from "./live.ts";
export { DEFAULT_DESKTOP_SETTINGS, loadSettings, saveSettings } from "./settings.ts";
export type { DesktopSettings } from "./settings.ts";
export { checkBaseUrl } from "./urlRules.ts";
export { createPortTransport } from "./transport.ts";
export { DesktopNotificationPort, RowSchedulerStore, schedulerClock } from "./reminderAdapters.ts";
