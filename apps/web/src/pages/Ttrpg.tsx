import { Link, Route, Routes } from "react-router-dom";

import { CampaignList } from "../components/ttrpg/CampaignList";
import { CreatureLibrary } from "../components/ttrpg/CreatureLibrary";
import { RunPage } from "../components/ttrpg/RunPage";
import { EncounterPage } from "../components/ttrpg/EncounterPage";
import { CampaignPage } from "../components/ttrpg/CampaignPage";
import { useFeatures } from "../lib/features";
import { settingsPath } from "../lib/settingsSections";

/**
 * TTRPG module shell (TTRPG-01) and its campaign screens (TTRPG-02). While the feature is off the
 * route shows only how to turn it on; the server refuses the module's endpoints regardless.
 */
export function Ttrpg() {
  const { features, settled } = useFeatures();
  if (!settled) {
    return <div className="splash">Loading…</div>;
  }
  if (!features.ttrpg) {
    return (
      <section className="page">
        <h1>TTRPG</h1>
        <p className="muted">
          This module is off. Turn it on under{" "}
          <Link to={settingsPath("plugins")}>Settings → Plugins</Link>.
        </p>
      </section>
    );
  }
  return (
    <Routes>
      <Route index element={<CampaignList />} />
      <Route path="runs/:runId" element={<RunPage />} />
      <Route path="encounters/:encounterId" element={<EncounterPage />} />
      <Route path="creatures" element={<CreatureLibrary />} />
      <Route path=":campaignId" element={<CampaignPage />} />
    </Routes>
  );
}
