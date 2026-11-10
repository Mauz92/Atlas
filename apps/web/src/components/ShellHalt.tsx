import { useState } from "react";

import { desktopApi, type DesktopSnapshot } from "../lib/desktop";
import { SyncHaltScreen } from "./SyncHaltScreen";

/**
 * Connects the halt screen to the shell's engine (SYNC-11c): the three choices call the bridge, never
 * anything automatic. Rendered by `App` instead of the app while the engine waits for a person.
 */
export function ShellHalt({ snapshot }: { snapshot: DesktopSnapshot }) {
  const desktop = desktopApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const halt = snapshot.sync?.halt;
  if (!desktop || !halt) return null;

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SyncHaltScreen
      halt={halt}
      info={{ pending: snapshot.sync?.pending ?? 0, cursor: snapshot.sync?.cursor ?? 0 }}
      busy={busy}
      error={error}
      onReupload={() => void run(() => desktop.sync.confirmRestore())}
      onDiscard={() => void run(() => desktop.sync.discardLocal())}
      onSignIn={() => window.location.assign("/welcome.html")}
      onCheckAgain={() => void run(() => desktop.sync.resumeAfterUpdate())}
    />
  );
}
