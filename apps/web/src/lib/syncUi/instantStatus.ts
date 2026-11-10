/**
 * "Instant updates" status for Settings (SYNC-11b = the web half of M8-04f). Pure derivation of what
 * to say from facts the page can read; the component renders it. No endpoint, topic or token is ever
 * shown (only the last four characters the server itself returns), and nothing here sends anything.
 */
import type { PushUiState } from "../webpush";
import { relativeTime } from "./resolutionText";

export type Tone = "ok" | "warn" | "danger" | "quiet";

export interface StatusRow {
  id: string;
  label: string;
  value: string;
  tone: Tone;
  help: string;
}

/** The server's answer for this device's UnifiedPush destination (`GET /api/devices/current/hint`). */
export interface GatewayFacts {
  enabled: boolean;
  registered: boolean;
  endpoint_tail?: string | null;
  last_ok_at?: string | null;
  last_error_class?: string | null;
  failures?: number;
  invalid?: boolean;
}

export function notificationRow(state: PushUiState, permission: string): StatusRow {
  const base = { id: "notifications", label: "Notifications on this device" };
  switch (state) {
    case "unsupported":
      return { ...base, value: "Not supported", tone: "danger", help: "This browser cannot show notifications. Try a current Chrome, Edge, Firefox or Safari over a secure connection." };
    case "disabled":
      return { ...base, value: "Not available on this server", tone: "warn", help: "The server has no Web Push keys. Ask the operator to set the VAPID keys." };
    case "denied":
      return { ...base, value: "Blocked", tone: "danger", help: "Allow notifications for Atlas in your browser's site settings, then reload this page." };
    case "prompt":
      return { ...base, value: permission === "default" ? "Not asked yet" : "Off", tone: "quiet", help: "Turn notifications on above to be told when a reminder is due." };
    case "granted":
      return { ...base, value: "Allowed, not registered", tone: "warn", help: "Permission is granted but this device is not registered for reminders yet. Use the button above." };
    case "subscribed":
      return { ...base, value: "On", tone: "ok", help: "This device will show a notification when a reminder is due." };
  }
}

export function canTestNotification(state: PushUiState, permission: string): boolean {
  return permission === "granted" && state !== "unsupported";
}

export function liveRow(surface: "browser" | "desktop", live: boolean): StatusRow {
  if (surface === "browser") {
    return {
      id: "live",
      label: "Live connection",
      value: "Not used in a browser",
      tone: "quiet",
      help: "A browser tab looks for changes when you open it or come back to it. The desktop and phone apps keep a connection open and update at once.",
    };
  }
  return live
    ? { id: "live", label: "Live connection", value: "Connected", tone: "ok", help: "Changes made on other devices arrive within seconds." }
    : { id: "live", label: "Live connection", value: "Not connected", tone: "warn", help: "Atlas still syncs every few minutes and when you return to the window; changes just arrive later." };
}

export function lastHintRow(lastHintAt: number | null, now: number): StatusRow {
  return {
    id: "last-hint",
    label: "Last hint received",
    value: lastHintAt === null ? "None yet" : relativeTime(new Date(lastHintAt).toISOString(), now),
    tone: "quiet",
    help: "A hint only says that something changed; the data is then fetched with this device's own key.",
  };
}

export function gatewayRow(facts: GatewayFacts | null, failed: boolean, now: number): StatusRow {
  const base = { id: "gateway", label: "Server push gateway" };
  if (failed || facts === null) {
    return { ...base, value: "Could not be read", tone: "warn", help: "The server did not answer. Nothing was changed." };
  }
  if (!facts.enabled) {
    return { ...base, value: "Not configured", tone: "quiet", help: "The operator has not set up a push gateway (ntfy / UnifiedPush). It is only used by the Android app; the desktop app does not need it." };
  }
  if (!facts.registered) {
    return { ...base, value: "On, this device not registered", tone: "quiet", help: "The gateway is available. Only the Android app registers with it." };
  }
  const tail = facts.endpoint_tail ? ` (ending ${facts.endpoint_tail})` : "";
  if (facts.invalid) return { ...base, value: `Needs a new address${tail}`, tone: "warn", help: "The gateway forgot this device's topic. Register again in the Android app." };
  if ((facts.failures ?? 0) > 0) {
    return { ...base, value: `Failing${tail}`, tone: "warn", help: `The last ${facts.failures} sends failed (${facts.last_error_class ?? "unknown error"}). Syncing still works; updates arrive later.` };
  }
  return {
    ...base,
    value: `Working${tail}`,
    tone: "ok",
    help: facts.last_ok_at ? `Last delivered ${relativeTime(facts.last_ok_at, now)}.` : "Registered; nothing has been sent yet.",
  };
}
