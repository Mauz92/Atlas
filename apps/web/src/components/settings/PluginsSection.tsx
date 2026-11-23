import { useState } from "react";

import { setFeature, useFeatures } from "../../lib/features";
import { errorMessage } from "../../lib/settingsFormat";
import { SettingsRow } from "./SettingsRow";

/** Optional bundled modules (TTRPG-01). Every one starts off. */
export function PluginsSection() {
  const { features, settled } = useFeatures();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      await setFeature("ttrpg", enabled);
    } catch (err) {
      setError(errorMessage(err, "Could not change this setting"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-group">
      <SettingsRow
        label="TTRPG"
        htmlFor="plugin-ttrpg"
        description="Run a tabletop adventure with your book and dice: session notes, party state, encounter prep and a combat tracker. Turning it on creates nothing by itself; turning it off hides it and keeps your campaigns and notes."
      >
        <label className="settings-switch">
          <input
            id="plugin-ttrpg"
            type="checkbox"
            role="switch"
            checked={features.ttrpg}
            disabled={busy || !settled}
            onChange={(event) => void toggle(event.target.checked)}
          />
          {features.ttrpg ? "On" : "Off"}
        </label>
      </SettingsRow>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
