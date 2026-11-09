import type { HomeTimeZone } from "../api/client";

/** The browser's IANA zone ("Europe/Amsterdam"), or `null` when it cannot be determined. */
export function browserTimeZone(): string | null {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone ? zone : null;
  } catch {
    return null;
  }
}

/** A short fallback list for engines without `Intl.supportedValuesOf` (older WebViews). */
const FALLBACK_ZONES = [
  "UTC",
  "Europe/London",
  "Europe/Amsterdam",
  "Europe/Berlin",
  "Europe/Paris",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "Asia/Tokyo",
  "Australia/Sydney",
];

/** Every IANA zone the engine knows, always including `current` and the browser's own zone. */
export function listTimeZones(current: string | null): string[] {
  let zones: string[] = [];
  try {
    const supported = (
      Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    ).supportedValuesOf;
    zones = supported ? supported("timeZone") : [];
  } catch {
    zones = [];
  }
  const all = new Set<string>(zones.length > 0 ? zones : FALLBACK_ZONES);
  all.add("UTC");
  const browser = browserTimeZone();
  if (browser) all.add(browser);
  if (current) all.add(current);
  return [...all].sort((a, b) => a.localeCompare(b));
}

/** The slice of the API the first-sign-in default needs (narrow so a test can fake it). */
export interface HomeTimeZoneApi {
  get: () => Promise<HomeTimeZone>;
  set: (zone: string | null) => Promise<HomeTimeZone>;
}

/**
 * First sign-in default (ADR-0068 Q6): when the owner has no home time zone yet, adopt the
 * browser's. An existing value is never overwritten, so a zone chosen on another device or in
 * Settings wins. Returns the zone that was set, or `null` when nothing was changed.
 */
export async function ensureHomeTimeZone(api: HomeTimeZoneApi): Promise<string | null> {
  const current = await api.get();
  if (current.time_zone) return null;
  const zone = browserTimeZone();
  if (!zone) return null;
  const saved = await api.set(zone);
  return saved.time_zone ?? null;
}
