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
    needs_reauth: false,
    ...overrides,
  };
}

import type { CalendarProviderAccount, CalendarSource } from "../api/client";

/** A complete `CalendarSource` (Settings -> Calendar, event colours), for component tests. */
export function makeSource(overrides: Partial<CalendarSource> = {}): CalendarSource {
  return {
    id: "src-1", provider: "google", name: "Owner", color: "1", time_zone: "Europe/Berlin",
    is_read_only: false, is_primary: true, selected: true, feed_url_display: null, is_import: false,
    state: "idle", last_success_at: "2026-11-10T09:00:00Z", last_error: null, last_error_at: null,
    ...overrides,
  };
}

/** A complete provider card from `GET /api/calendar/accounts`. */
export function makeAccount(overrides: Partial<CalendarProviderAccount> = {}): CalendarProviderAccount {
  return {
    provider: "google", label: "Google Calendar", configured: true, setup_problems: [],
    redirect_uri: "https://atlas.example.test/api/calendar/google/callback",
    connected: false, needs_reauth: false, scopes: [], calendars: [],
    ...overrides,
  };
}
