import { useCallback, useEffect, useState } from "react";

import {
  notificationsApi,
  type ReminderPreferences,
  type ReminderTiming,
} from "../api/client";

/** The slice of the notifications API the hook needs (kept narrow so it can be faked in tests). */
export interface ReminderPreferencesApi {
  get: () => Promise<ReminderPreferences>;
  update: (timing: ReminderTiming | null) => Promise<ReminderPreferences>;
}

export interface ReminderPreferencesResult {
  /** The user's current default reminder timing, or `null` when reminders are off. */
  timing: ReminderTiming | null;
  /** True until the current default has been read. */
  loading: boolean;
  /** True while a save is in flight. */
  saving: boolean;
  error: string | null;
  /** True after a successful save, until the next save starts. */
  saved: boolean;
  /** Persist a new default timing (`null` turns reminders off). */
  save: (timing: ReminderTiming | null) => Promise<void>;
}

const defaultApi: ReminderPreferencesApi = {
  get: () => notificationsApi.reminderPreferences(),
  update: (timing) => notificationsApi.updateReminderPreferences(timing),
};

/**
 * Read and persist the user's default reminder timing (M8-05).
 *
 * The hook owns the loading/saving/error/saved states and the API calls; the vocabulary and
 * validation live in `lib/reminders.ts`. It takes the API as an argument so tests can drive it over
 * a fake, defaulting to the app's real client.
 */
export function useReminderPreferences(
  api: ReminderPreferencesApi = defaultApi,
): ReminderPreferencesResult {
  const [timing, setTiming] = useState<ReminderTiming | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const preferences = await api.get();
      setTiming(preferences.default);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load reminder timing");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (next: ReminderTiming | null) => {
      setSaving(true);
      setSaved(false);
      setError(null);
      try {
        const preferences = await api.update(next);
        setTiming(preferences.default);
        setSaved(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save the reminder timing");
      } finally {
        setSaving(false);
      }
    },
    [api],
  );

  return { timing, loading, saving, error, saved, save };
}
