import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

/**
 * Whether a CSS media query matches, kept live. Where `matchMedia` does not exist (jsdom) the
 * `fallback` is returned, so component tests get the wide desktop layout.
 */
export function useMediaQuery(query: string, fallback = false): boolean {
  const subscribe = useCallback(
    (callback: () => void) => {
      const media = typeof window.matchMedia === "function" ? window.matchMedia(query) : null;
      media?.addEventListener?.("change", callback);
      return () => media?.removeEventListener?.("change", callback);
    },
    [query],
  );
  const read = () =>
    typeof window.matchMedia === "function" ? window.matchMedia(query).matches : fallback;
  return useSyncExternalStore(subscribe, read, () => fallback);
}

/**
 * Connectivity: `navigator.onLine` at mount, then whatever the `online`/`offline` events say (the
 * same rule `useReconciliation` uses, so the status bar and the Sync page agree).
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );
  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);
  return online;
}
