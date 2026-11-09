import type { FireKey, SchedulerState } from "./types.ts";

export function fireKey(reminderId: string, effectiveAtMs: number): FireKey {
  return `${reminderId}:${new Date(effectiveAtMs).toISOString()}`;
}

/** FNV-1a over the key, folded into a positive 31-bit integer (Android notification ids are Int). */
export function hashKey(key: FireKey): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h & 0x7fffffff) || 1;
}

/**
 * The stable notification id of `key`: its hash, or the next free value when another live key owns
 * the hash. The mapping is persisted in `state.ids`, so a restart yields the same id and re-arming
 * replaces the alarm instead of adding a second one.
 */
export function idFor(state: SchedulerState, key: FireKey): number {
  let candidate = hashKey(key);
  for (;;) {
    const owner = state.ids[String(candidate)];
    if (owner === undefined || owner === key) {
      state.ids[String(candidate)] = key;
      return candidate;
    }
    candidate = (candidate % 0x7fffffff) + 1;
  }
}
