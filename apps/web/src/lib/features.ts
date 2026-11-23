/**
 * Optional feature switches (TTRPG-01), read from `GET /api/features`.
 *
 * A tiny external store so Settings and the navigation agree at once when a switch changes. Until
 * the first answer arrives, and whenever the request fails, every feature counts as OFF: entry
 * points are hidden by default and the server still refuses the feature's endpoints (the real
 * protection). Hiding is a convenience, never the guard.
 */
import { useEffect, useSyncExternalStore } from "react";

import { featuresApi, type Features } from "../api/client";

export const NO_FEATURES: Features = { ttrpg: false };

interface Snapshot {
  features: Features;
  /** True once an answer (or a failure) has been received. */
  settled: boolean;
}

let snapshot: Snapshot = { features: NO_FEATURES, settled: false };
const listeners = new Set<() => void>();

function publish(next: Snapshot) {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function loadFeatures(): Promise<void> {
  try {
    publish({ features: await featuresApi.get(), settled: true });
  } catch {
    publish({ features: NO_FEATURES, settled: true });
  }
}

/** Switch a feature; rejects (and leaves the state alone) when the server refuses. */
export async function setFeature(
  feature: keyof Features,
  enabled: boolean,
): Promise<void> {
  publish({ features: await featuresApi.set(feature, enabled), settled: true });
}

/** Forget everything (sign-out, tests). */
export function resetFeatures() {
  publish({ features: NO_FEATURES, settled: false });
}

/** The caller's switches; loads them once on first use while signed in. */
export function useFeatures(): Snapshot {
  const current = useSyncExternalStore(subscribe, () => snapshot);
  useEffect(() => {
    if (!snapshot.settled) void loadFeatures();
  }, []);
  return current;
}
