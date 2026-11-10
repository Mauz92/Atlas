import { useEffect, useState } from "react";

import { notesApi, projectsApi, tasksApi } from "../api/client";

interface Ref {
  entity_type: string;
  entity_id: string;
}

/** `null` = looked up and gone (deleted) or unreadable; a missing key = not looked up yet. */
const cache = new Map<string, string | null>();

async function lookup(ref: Ref): Promise<string | null> {
  try {
    if (ref.entity_type === "task") return (await tasksApi.get(ref.entity_id)).title;
    if (ref.entity_type === "project") return (await projectsApi.get(ref.entity_id)).name;
    if (ref.entity_type === "note") return (await notesApi.get(ref.entity_id)).title;
  } catch {
    return null;
  }
  return null;
}

/**
 * The current titles of the entities a list mentions (the log itself holds no text, SYNC_PROTOCOL 9).
 * Looked up one by one, once per id; a failed lookup leaves the generic "task"/"note" wording.
 */
export function useEntityTitles(refs: readonly Ref[]): ReadonlyMap<string, string | null> {
  const [titles, setTitles] = useState<ReadonlyMap<string, string | null>>(() => new Map(cache));
  const wanted = refs.map((r) => `${r.entity_type}:${r.entity_id}`).join("|");

  useEffect(() => {
    let cancelled = false;
    const missing = refs.filter((r) => !cache.has(`${r.entity_type}:${r.entity_id}`));
    if (missing.length === 0) {
      setTitles(new Map(cache));
      return;
    }
    void (async () => {
      for (const ref of missing) {
        cache.set(`${ref.entity_type}:${ref.entity_id}`, await lookup(ref));
        if (cancelled) return;
        setTitles(new Map(cache));
      }
    })();
    return () => {
      cancelled = true;
    };
    // `wanted` is the stable key of `refs`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);

  const out = new Map<string, string | null>();
  for (const r of refs) {
    const key = `${r.entity_type}:${r.entity_id}`;
    if (titles.has(key)) out.set(r.entity_id, titles.get(key) ?? null);
  }
  return out;
}

/** Forget what was looked up (after an undo the title may be different). */
export function forgetEntityTitles(): void {
  cache.clear();
}
