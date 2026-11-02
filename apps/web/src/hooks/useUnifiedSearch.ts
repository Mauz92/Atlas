import { useEffect, useState } from "react";

import { searchApi, type SearchResults } from "../api/client";

export interface UnifiedSearch {
  /** The latest answer; stays on screen while the next one loads. `null` before the first. */
  results: SearchResults | null;
  loading: boolean;
  /** The server's message, verbatim. */
  error: string | null;
}

interface Settled {
  text: string;
  results: SearchResults | null;
  error: string | null;
}

/**
 * Debounced `GET /api/search` for the palette and the Search page (MU-05). A newer keystroke
 * aborts the older request, so a slow answer can never replace a newer one.
 */
export function useUnifiedSearch(
  query: string,
  limit: number,
  delayMs = 150,
): UnifiedSearch {
  const text = query.trim();
  const [settled, setSettled] = useState<Settled>({
    text: "",
    results: null,
    error: null,
  });

  useEffect(() => {
    if (!text) {
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      searchApi
        .search(text, { limit, signal: controller.signal })
        .then((results) => setSettled({ text, results, error: null }))
        .catch((err: unknown) => {
          if (controller.signal.aborted) {
            return;
          }
          setSettled({
            text,
            results: null,
            error: err instanceof Error ? err.message : "Search failed",
          });
        });
    }, delayMs);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [text, limit, delayMs]);

  if (!text) {
    return { results: null, loading: false, error: null };
  }
  return {
    results: settled.results,
    loading: settled.text !== text,
    error: settled.text === text ? settled.error : null,
  };
}
