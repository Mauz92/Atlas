import { useCallback, useEffect, useState } from "react";

import { instanceApi, type InstanceInfo } from "../api/client";
import { errorMessage } from "../lib/settingsFormat";

/** Instance and backup information (`GET /api/instance`), loaded when a Settings section needs it. */
export function useInstanceInfo() {
  const [info, setInfo] = useState<InstanceInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setInfo(await instanceApi.get());
    } catch (err) {
      setError(errorMessage(err, "Could not load the instance information"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { info, error, reload: load };
}
