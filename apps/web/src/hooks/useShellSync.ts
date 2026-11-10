import { useEffect, useState } from "react";

import { desktopApi, type DesktopSnapshot } from "../lib/desktop";

/**
 * The desktop shell's runtime snapshot (engine status, halt, live connection), or `null` in a
 * browser, where there is no engine and the hook does nothing (SYNC-11c). Subscribes for changes.
 */
export function useShellSync(): DesktopSnapshot | null {
  const desktop = desktopApi();
  const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(null);
  useEffect(() => {
    if (!desktop) return undefined;
    let active = true;
    void desktop.snapshot().then((s) => active && setSnapshot(s));
    const stop = desktop.subscribe((s) => active && setSnapshot(s));
    return () => {
      active = false;
      stop();
    };
  }, [desktop]);
  return snapshot;
}
