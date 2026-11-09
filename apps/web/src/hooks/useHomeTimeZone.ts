import { useCallback, useEffect, useState } from "react";

import { notificationsApi } from "../api/client";
import type { HomeTimeZoneApi } from "../lib/homeTimeZone";

const defaultApi: HomeTimeZoneApi = {
  get: () => notificationsApi.homeTimeZone(),
  set: (zone) => notificationsApi.setHomeTimeZone(zone),
};

export interface HomeTimeZoneResult {
  /** The saved zone, or `null` when none is set (reminders then use UTC for zone-less tasks). */
  zone: string | null;
  loading: boolean;
  saving: boolean;
  saved: boolean;
  error: string | null;
  save: (zone: string | null) => Promise<void>;
}

/** Read and persist the owner's home time zone (ADR-0068 Q6). */
export function useHomeTimeZone(api: HomeTimeZoneApi = defaultApi): HomeTimeZoneResult {
  const [zone, setZone] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api
      .get()
      .then((value) => {
        if (active) setZone(value.time_zone ?? null);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : "Could not load the time zone");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api]);

  const save = useCallback(
    async (next: string | null) => {
      setSaving(true);
      setSaved(false);
      setError(null);
      try {
        const value = await api.set(next);
        setZone(value.time_zone ?? null);
        setSaved(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save the time zone");
      } finally {
        setSaving(false);
      }
    },
    [api],
  );

  return { zone, loading, saving, saved, error, save };
}
