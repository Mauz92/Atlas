import { useCallback, useEffect, useRef, useState } from "react";

import type { CacheEntry } from "../lib/localCache";
import { getReconciler, type Reconciler } from "../lib/reconciliation";

export interface ReconciliationResult {
  /** The conflicts to surface (local edits kept, the server never clobbered). */
  conflicts: CacheEntry[];
  /** True while a reconciliation pass is in flight. */
  busy: boolean;
  /** A failure from a pass (kept off the counts so the last-known state stays visible). */
  error: string | null;
  /** `navigator.onLine` when the environment exposes it, else `true`. */
  online: boolean;
  /** Run a pass now (the manual "sync"/"retry" action). */
  reconcile: () => Promise<void>;
}

/**
 * Run the reconnect reconciliation pass on lifecycle signals (M7-04).
 *
 * A pass is triggered when the browser regains connectivity (`window` `online`), when the tab is
 * focused again (`focus`) and on first mount, plus on demand through {@link reconcile} — the manual
 * action. All the logic lives in `lib/reconciliation.ts`; the hook only schedules passes, prevents
 * overlap and exposes the surfaced conflicts (business logic stays out of components, AGENTS.md §6).
 *
 * It takes the reconciler as an argument so it can be tested over in-memory state, defaulting to the
 * app-wide durable instance. Passes are idempotent, so an extra trigger is harmless.
 */
export function useReconciliation(
  reconciler: Reconciler = getReconciler(),
): ReconciliationResult {
  const [conflicts, setConflicts] = useState<CacheEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(
    () => (typeof navigator !== "undefined" ? navigator.onLine : true),
  );
  const running = useRef(false);

  const loadConflicts = useCallback(async () => {
    try {
      setConflicts(await reconciler.conflicts());
    } catch {
      // The cache is a best-effort surface; a read failure must not break the pass.
    }
  }, [reconciler]);

  const reconcile = useCallback(async () => {
    // Never overlap passes: a focus and an online event often arrive together.
    if (running.current) {
      return;
    }
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await reconciler.run();
      setConflicts(result.conflicts);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reconcile changes");
      await loadConflicts();
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, [loadConflicts, reconciler]);

  useEffect(() => {
    void reconcile();

    const handleOnline = () => {
      setOnline(true);
      void reconcile();
    };
    const handleOffline = () => setOnline(false);
    const handleFocus = () => void reconcile();

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("focus", handleFocus);
    };
  }, [reconcile]);

  return { conflicts, busy, error, online, reconcile };
}
