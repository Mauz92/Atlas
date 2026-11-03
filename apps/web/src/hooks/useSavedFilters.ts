import { useCallback, useState } from "react";

import {
  loadSavedFilters,
  MAX_SAVED_FILTERS,
  storeSavedFilters,
  type SavedFilter,
} from "../lib/taskFilters";

export interface SavedFilters {
  saved: SavedFilter[];
  /** Keep the view (`query` = the URL query string) under `name`; returns false when refused. */
  save: (name: string, query: string) => boolean;
  remove: (id: string) => void;
  /** Why the last save was refused, or that the browser would not store it. */
  error: string | null;
}

/** Saved Tasks views (MU-03): shortcuts kept in this browser only; the server knows nothing of them. */
export function useSavedFilters(): SavedFilters {
  const [saved, setSaved] = useState<SavedFilter[]>(loadSavedFilters);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(
    (name: string, query: string) => {
      const trimmed = name.trim();
      if (!trimmed) return false;
      if (saved.length >= MAX_SAVED_FILTERS) {
        setError(`You can keep at most ${MAX_SAVED_FILTERS} saved filters.`);
        return false;
      }
      const next = [...saved, { id: crypto.randomUUID(), name: trimmed, query }];
      setSaved(next);
      setError(
        storeSavedFilters(next)
          ? null
          : "This browser would not store it; the filter is kept until you leave the page.",
      );
      return true;
    },
    [saved],
  );

  const remove = useCallback(
    (id: string) => {
      const next = saved.filter((entry) => entry.id !== id);
      setSaved(next);
      storeSavedFilters(next);
    },
    [saved],
  );

  return { saved, save, remove, error };
}
