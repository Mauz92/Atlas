import { useEffect } from "react";

import { notificationsApi } from "../api/client";
import { ensureHomeTimeZone } from "../lib/homeTimeZone";

/**
 * Renders nothing. After sign-in it asks once whether the owner has a home time zone and, if not,
 * adopts the browser's (ADR-0068 Q6). Best-effort: a failure is ignored (Settings still offers the
 * field) and an existing choice is never overwritten.
 */
export function HomeTimeZoneDefault() {
  useEffect(() => {
    void ensureHomeTimeZone({
      get: () => notificationsApi.homeTimeZone(),
      set: (zone) => notificationsApi.setHomeTimeZone(zone),
    }).catch(() => undefined);
  }, []);
  return null;
}
