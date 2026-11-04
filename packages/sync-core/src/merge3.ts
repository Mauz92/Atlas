/**
 * Three-way line merge for note text (the client twin of `atlas/notes/merge.py`, SYNC-04).
 *
 * The client uses it to rebase text typed while a save was in flight onto the text the server
 * returned. It is deliberately as conservative as the server's: a region changed by one side only
 * (or identically by both) merges; anything that touches or overlaps is NOT merged and the caller
 * keeps both versions. Lines keep their `\n`; the final newline is merged separately; a
 * front-matter block that would be assembled from two sides is a conflict.
 */

export const MAX_NOTE_BYTES = 5 * 1024 * 1024;
export const MAX_LINES = 200_000;
export const MAX_CELLS = 4_000_000;

export type MergeReason = "overlap" | "front_matter" | "too_large";

export interface MergeResult {
  text: string | null;
  reason: MergeReason | null;
}

function split(text: string): { lines: string[]; final: boolean } {
  if (text === "") return { lines: [], final: true };
  const final = text.endsWith("\n");
  const parts = (final ? text : text + "\n").split("\n");
  parts.pop();
  return { lines: parts.map((p) => p + "\n"), final };
}

/** Monotonic matching of equal lines (an LCS): base index -> other index. */
function match(base: string[], other: string[]): Map<number, number> | null {
  const n = base.length;
  const m = other.length;
  let prefix = 0;
  while (prefix < n && prefix < m && base[prefix] === other[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < n - prefix &&
    suffix < m - prefix &&
    base[n - 1 - suffix] === other[m - 1 - suffix]
  )
    suffix++;
  const pairs = new Map<number, number>();
  for (let i = 0; i < prefix; i++) pairs.set(i, i);
  const a = base.slice(prefix, n - suffix);
  const b = other.slice(prefix, m - suffix);
  if (a.length > 0 && b.length > 0) {
    if (a.length * b.length > MAX_CELLS) return null;
    const w = b.length + 1;
    const table = new Uint32Array((a.length + 1) * w);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        table[i * w + j] =
          a[i] === b[j]
            ? table[(i + 1) * w + j + 1]! + 1
            : Math.max(table[(i + 1) * w + j]!, table[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        pairs.set(prefix + i, prefix + j);
        i++;
        j++;
      } else if (table[(i + 1) * w + j]! >= table[i * w + j + 1]!) i++;
      else j++;
    }
  }
  for (let k = 0; k < suffix; k++) pairs.set(n - suffix + k, m - suffix + k);
  return pairs;
}

const FRONT_MATTER = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

function frontMatter(text: string): string {
  const found = FRONT_MATTER.exec(text);
  return found ? found[0] : "";
}

function equalLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Merge `theirs` (the server's current text) and `ours` (the local edit), both from `base`. */
export function merge3(base: string, theirs: string, ours: string): MergeResult {
  if (theirs === ours || ours === base) return { text: theirs, reason: null };
  if (theirs === base) return { text: ours, reason: null };
  const b = split(base);
  const t = split(theirs);
  const o = split(ours);
  if (Math.max(b.lines.length, t.lines.length, o.lines.length) > MAX_LINES)
    return { text: null, reason: "too_large" };
  const theirsMatch = match(b.lines, t.lines);
  const oursMatch = match(b.lines, o.lines);
  if (theirsMatch === null || oursMatch === null) return { text: null, reason: "too_large" };

  const anchors = [...theirsMatch.keys()].filter((i) => oursMatch.has(i)).sort((x, y) => x - y);
  const merged: string[] = [];
  let pb = 0;
  let pt = 0;
  let po = 0;
  const ends: (number | null)[] = [...anchors, null];
  for (const anchor of ends) {
    const nb = anchor === null ? b.lines.length : anchor;
    const nt = anchor === null ? t.lines.length : theirsMatch.get(anchor)!;
    const no = anchor === null ? o.lines.length : oursMatch.get(anchor)!;
    const bRegion = b.lines.slice(pb, nb);
    const tRegion = t.lines.slice(pt, nt);
    const oRegion = o.lines.slice(po, no);
    if (equalLines(tRegion, oRegion) || equalLines(oRegion, bRegion)) merged.push(...tRegion);
    else if (equalLines(tRegion, bRegion)) merged.push(...oRegion);
    else return { text: null, reason: "overlap" };
    if (anchor !== null) {
      merged.push(b.lines[anchor]!);
      pb = anchor + 1;
      pt = theirsMatch.get(anchor)! + 1;
      po = oursMatch.get(anchor)! + 1;
    }
  }
  const final = t.final === o.final || o.final === b.final ? t.final : o.final;
  let text = merged.join("");
  if (!final && text.endsWith("\n")) text = text.slice(0, -1);
  if (utf8Length(text) > MAX_NOTE_BYTES) return { text: null, reason: "too_large" };
  const fm = frontMatter(text);
  if (fm !== frontMatter(theirs) && fm !== frontMatter(ours))
    return { text: null, reason: "front_matter" };
  return { text, reason: null };
}
