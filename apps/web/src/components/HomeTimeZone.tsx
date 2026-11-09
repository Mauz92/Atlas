import { useMemo } from "react";

import { listTimeZones } from "../lib/homeTimeZone";
import { SettingsRow } from "./settings/SettingsRow";

interface HomeTimeZoneProps {
  /** The saved zone, or `null` when none is set. */
  zone: string | null;
  loading?: boolean;
  saving?: boolean;
  saved?: boolean;
  error?: string | null;
  onSave: (zone: string | null) => void;
}

const UNSET = "";

/**
 * The home time zone (ADR-0068 Q6): the zone reminder times use for tasks that carry none, so
 * "09:00" means 09:00 where you live rather than in UTC. Presentational, one labelled select in the
 * shared settings row; saves on change.
 */
export function HomeTimeZone({
  zone,
  loading = false,
  saving = false,
  saved = false,
  error = null,
  onSave,
}: HomeTimeZoneProps) {
  const zones = useMemo(() => listTimeZones(zone), [zone]);
  if (loading) {
    return (
      <p className="muted" role="status">
        Loading time zone…
      </p>
    );
  }
  return (
    <section className="reminder-preferences home-time-zone">
      <h2>Home time zone</h2>
      <SettingsRow
        label="Time zone for reminders"
        htmlFor="home-time-zone"
        description="Used for tasks that have no time zone of their own. Without one, reminder times are read as UTC."
      >
        <select
          id="home-time-zone"
          value={zone ?? UNSET}
          disabled={saving}
          onChange={(event) => onSave(event.target.value === UNSET ? null : event.target.value)}
        >
          <option value={UNSET}>Not set (UTC)</option>
          {zones.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </SettingsRow>
      {saved ? (
        <p className="reminder-saved" role="status">
          Saved.
        </p>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
