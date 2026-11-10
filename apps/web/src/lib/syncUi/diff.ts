/**
 * A line diff for the note conflict resolver (SYNC-11a-3). Longest-common-subsequence over lines,
 * bounded (notes are at most a few hundred KiB; past `MAX_CELLS` it falls back to "everything
 * differs" instead of freezing the page). No dependency: the two texts are only displayed, never
 * merged by this code (the person chooses; the server merge is the only automatic merge).
 */
export type DiffKind = "same" | "removed" | "added";
export interface DiffLine {
  kind: DiffKind;
  text: string;
}

const MAX_CELLS = 4_000_000;

export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** `removed` = only in `theirs`, `added` = only in `mine` (reading "from theirs to mine"). */
export function diffLines(theirs: string, mine: string): DiffLine[] {
  const a = splitLines(theirs);
  const b = splitLines(mine);
  // trim the common head and tail: most conflicts touch a small part
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const out: DiffLine[] = a.slice(0, head).map((text) => ({ kind: "same", text }));
  if ((midA.length + 1) * (midB.length + 1) > MAX_CELLS) {
    out.push(...midA.map((text): DiffLine => ({ kind: "removed", text })), ...midB.map((text): DiffLine => ({ kind: "added", text })));
  } else {
    const n = midA.length;
    const m = midB.length;
    const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i]![j] = midA[i] === midB[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        out.push({ kind: "same", text: midA[i]! });
        i++;
        j++;
      } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
        out.push({ kind: "removed", text: midA[i++]! });
      } else {
        out.push({ kind: "added", text: midB[j++]! });
      }
    }
    while (i < n) out.push({ kind: "removed", text: midA[i++]! });
    while (j < m) out.push({ kind: "added", text: midB[j++]! });
  }
  out.push(...a.slice(a.length - tail).map((text): DiffLine => ({ kind: "same", text })));
  return out;
}

export function changedLineCount(diff: readonly DiffLine[]): number {
  return diff.filter((line) => line.kind !== "same").length;
}
