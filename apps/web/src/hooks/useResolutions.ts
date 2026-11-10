import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Resolution } from "../api/client";
import { NO_NAMES, type Names } from "../lib/syncUi/resolutionText";
import { defaultResolutionsSource, UndoKeys, type ResolutionsSource } from "../lib/syncUi/source";
import type { UndoOutcome } from "../lib/syncUi/undoOutcome";

const PAGE = 20;

export interface ResolutionsState {
  items: Resolution[];
  names: Names;
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  /** The id being undone, if any (one at a time keeps the answers readable). */
  undoing: string | null;
  /** The last answer per resolution, shown on its card until the next tap. */
  outcomes: ReadonlyMap<string, UndoOutcome>;
  reload: () => Promise<void>;
  loadMore: () => Promise<void>;
  undo: (resolution: Resolution) => Promise<UndoOutcome>;
}

/** Merge a fresh first page into what is shown: replace by id, keep older pages, newest first. */
export function mergePages(shown: readonly Resolution[], fresh: readonly Resolution[]): Resolution[] {
  const byId = new Map(shown.map((item) => [item.id, item]));
  for (const item of fresh) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
}

/**
 * The resolution log for the Changes page: paged, with device names, and an undo that keeps one
 * `Idempotency-Key` per tap (a retry after a lost answer cannot undo twice).
 */
export function useResolutions(source: ResolutionsSource = defaultResolutionsSource()): ResolutionsState {
  const [items, setItems] = useState<Resolution[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [names, setNames] = useState<Names>(NO_NAMES);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, UndoOutcome>>(new Map());
  const keys = useRef(new UndoKeys());
  const alive = useRef(true);
  const started = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [page, devices, own] = await Promise.all([source.page(null, PAGE), source.deviceNames(), source.ownDeviceId()]);
      if (!alive.current) return;
      setItems((shown) => mergePages(shown, page.items));
      if (!started.current) {
        started.current = true;
        setNext(page.next);
      }
      setNames({ devices, ownDeviceId: own });
    } catch {
      if (alive.current) setError("Could not load the changes. Check your connection and try again.");
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [source]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const loadMore = useCallback(async () => {
    if (next === null) return;
    setLoadingMore(true);
    try {
      const page = await source.page(next, PAGE);
      if (!alive.current) return;
      setItems((shown) => mergePages(shown, page.items));
      setNext(page.next);
    } catch {
      if (alive.current) setError("Could not load older changes.");
    } finally {
      if (alive.current) setLoadingMore(false);
    }
  }, [next, source]);

  const undo = useCallback(
    async (resolution: Resolution): Promise<UndoOutcome> => {
      setUndoing(resolution.id);
      const outcome = await source.undo(resolution, keys.current.keyFor(resolution.id));
      if (outcome.kind !== "unreachable" && outcome.safe) keys.current.settle(resolution.id);
      if (alive.current) {
        setOutcomes((held) => new Map(held).set(resolution.id, outcome));
        setUndoing(null);
        if (outcome.refresh) await reload();
      }
      return outcome;
    },
    [reload, source],
  );

  return useMemo(
    () => ({ items, names, loading, error, hasMore: next !== null, loadingMore, undoing, outcomes, reload, loadMore, undo }),
    [items, names, loading, error, next, loadingMore, undoing, outcomes, reload, loadMore, undo],
  );
}
