import type { NoteSummary } from "../api/client";

/**
 * A task title from text selected in a note (MU-06). Only the first non-empty line is used, with
 * the Markdown that decorated it (list marker, checkbox, heading hashes, quote) removed, so
 * "- [ ] Call Sam" becomes "Call Sam". The text is not shortened: the server's length limit is
 * enforced by the server and its message shown, and the person can edit the title before creating.
 */
export function taskTitleFromText(text: string): string {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim() !== "") ?? "";
  return line
    .trim()
    .replace(/^(?:>\s*)*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)?(?:\[[ xX]\](?:\s+|$))?/, "")
    .trim();
}

/** Characters that would change how `[[target]]` is parsed (alias, heading, block, brackets). */
const UNSAFE_IN_WIKI_LINK = /[[\]|#^\\]/;

/**
 * A note's wiki-link target: its path without the `.md` suffix (the server adds it back when it
 * indexes links). Notes whose path contains link syntax are not offered, rather than escaped.
 */
export function wikiTarget(note: Pick<NoteSummary, "path">): string | null {
  const target = note.path.replace(/\.md$/i, "");
  return UNSAFE_IN_WIKI_LINK.test(target) ? null : target;
}

export interface WikiCompletion {
  /** What is inserted between `[[` and `]]`. */
  target: string;
  /** The note's title, shown beside the path. */
  title: string;
}

/**
 * Notes matching the text typed after `[[`: every word must appear in the path or title
 * (case-insensitive); path-prefix matches first. Bounded so the list stays usable.
 */
export function wikiCompletions(
  notes: readonly NoteSummary[],
  typed: string,
  limit = 20,
): WikiCompletion[] {
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean);
  const found: (WikiCompletion & { rank: number })[] = [];
  for (const note of notes) {
    const target = wikiTarget(note);
    if (target === null) continue;
    const haystack = `${target} ${note.title}`.toLowerCase();
    if (!words.every((word) => haystack.includes(word))) continue;
    found.push({
      target,
      title: note.title,
      rank: target.toLowerCase().startsWith(typed.toLowerCase()) ? 0 : 1,
    });
  }
  return found
    .sort((a, b) => a.rank - b.rank || a.target.localeCompare(b.target))
    .slice(0, limit)
    .map(({ target, title }) => ({ target, title }));
}

/**
 * The note a `[[…]]` link points at, resolved like the server does when it indexes links: alias
 * (`|`), heading (`#`) and block (`^`) parts are dropped, a leading `./` is dropped and `.md` is
 * added. Exact path first, then a case-insensitive match. `label` is what the link shows.
 */
export function resolveWikiLink(
  notes: readonly Pick<NoteSummary, "id" | "path">[],
  raw: string,
): { id: string | null; target: string; label: string } {
  const [written, alias] = raw.split("|", 2);
  const label = (alias ?? written.split(/[#^]/, 1)[0]).trim() || raw.trim();
  let target = written.split("#", 1)[0].split("^", 1)[0].trim().replace(/^(\.\/)+/, "").replace(/\\/g, "/");
  if (target && !/\.md$/i.test(target)) target += ".md";
  const exact = notes.find((note) => note.path === target);
  const found = exact ?? notes.find((note) => note.path.toLowerCase() === target.toLowerCase());
  return { id: target ? (found?.id ?? null) : null, target, label };
}
