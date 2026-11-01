import type { CalendarCursorStatus, ProviderSyncStatus } from "../api/client";

/** A complete `CalendarCursorStatus` with sensible defaults, for component tests. */
export function makeCursorStatus(
  overrides: Partial<CalendarCursorStatus> = {},
): CalendarCursorStatus {
  return {
    calendar_id: "cal-primary",
    state: "idle",
    cursor_health: "ok",
    cursor_type: "sync_token",
    has_cursor: true,
    last_success_at: "2026-10-27T09:00:00+00:00",
    last_error: null,
    last_error_at: null,
    ...overrides,
  };
}

/** A complete `ProviderSyncStatus` with sensible defaults, for sync-status component tests. */
export function makeProviderSyncStatus(
  overrides: Partial<ProviderSyncStatus> = {},
): ProviderSyncStatus {
  return {
    provider: "google",
    connected: true,
    state: "idle",
    last_success_at: "2026-10-27T09:00:00+00:00",
    last_error: null,
    last_error_at: null,
    calendars: [makeCursorStatus()],
    ...overrides,
  };
}
