import { useEffect, useState } from "react";

import { ttrpgApi } from "../api/client";

export interface NavCampaign {
  id: string;
  title: string;
}

/**
 * The campaigns listed under the TTRPG category of the sidebar. Loaded only while the module is on,
 * and again whenever a TTRPG page is opened (a campaign may just have been created or archived), so
 * the list stays current without a push channel. A failure leaves the list as it was: the category
 * and its three fixed entries do not depend on it.
 */
export function useCampaignsForNav(enabled: boolean, pathname: string): NavCampaign[] {
  const [campaigns, setCampaigns] = useState<NavCampaign[]>([]);
  const onTtrpgPage = pathname === "/ttrpg" || pathname.startsWith("/ttrpg/");
  const onCampaignList = pathname === "/ttrpg";

  useEffect(() => {
    if (!enabled) {
      setCampaigns([]);
      return undefined;
    }
    let cancelled = false;
    ttrpgApi
      .campaigns()
      .then((list) => {
        if (!cancelled) setCampaigns(list.items.map((c) => ({ id: c.id, title: c.title })));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // look again when a TTRPG page is entered or left, and on the list (where campaigns are made)
  }, [enabled, onTtrpgPage, onCampaignList]);

  return campaigns;
}
