/**
 * Matching and ordering helpers for the command palette (MU-05). Notes, tasks and projects are
 * matched by the server (`GET /api/search`); this file only filters the palette's own commands.
 */

/**
 * How well `query` matches `text`, lower is better, `null` for no match. Case-insensitive: a prefix
 * of the text (or of a word in it) beats a substring, which beats an in-order subsequence
 * ("tsk" finds "Tasks"). An empty query matches everything equally.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return 0;
  }
  const haystack = text.toLowerCase();
  const at = haystack.indexOf(needle);
  if (at >= 0) {
    const wordStart = at === 0 || /[\s/_-]/.test(haystack[at - 1]);
    return (at === 0 ? 0 : wordStart ? 1 : 2) + at / 1000;
  }
  let from = 0;
  let gaps = 0;
  for (const char of needle) {
    const found = haystack.indexOf(char, from);
    if (found < 0) {
      return null;
    }
    gaps += found - from;
    from = found + 1;
  }
  return 10 + gaps / 1000;
}

/** Keep the items that match, best first (stable for equal scores). */
export function rankByQuery<T>(
  items: readonly T[],
  query: string,
  label: (item: T) => string,
): T[] {
  return items
    .map((item, index) => ({ item, index, score: fuzzyScore(query, label(item)) }))
    .filter((entry): entry is { item: T; index: number; score: number } => entry.score !== null)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.item);
}
