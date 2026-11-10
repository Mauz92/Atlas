/**
 * Conflict copies of notes (MARKDOWN_STORAGE: `<name> (conflict YYYY-MM-DD HHMMSS[ n]).md`, written
 * next to the note by the server whenever two edits cannot be merged). Pure helpers that pair a copy
 * with the note it was made from, so the Notes page can offer the resolver.
 */
const COPY = /^(?<stem>.*) \(conflict (?<stamp>\d{4}-\d{2}-\d{2} \d{6})(?: (?<n>\d+))?\)\.md$/;

export interface ConflictCopyName {
  /** The path the original note has (or had). */
  originalPath: string;
  stamp: string;
}

export function parseConflictCopyPath(path: string): ConflictCopyName | null {
  const slash = path.lastIndexOf("/");
  const folder = slash === -1 ? "" : path.slice(0, slash + 1);
  const name = slash === -1 ? path : path.slice(slash + 1);
  const match = COPY.exec(name);
  if (!match?.groups) return null;
  return { originalPath: `${folder}${match.groups["stem"]}.md`, stamp: match.groups["stamp"]! };
}

export interface NoteRef {
  id: string;
  path: string;
  title?: string;
}

export interface ConflictPair<T extends NoteRef> {
  copy: T;
  /** `null` when the original was renamed or deleted since: the copy then stands alone. */
  original: T | null;
  stamp: string;
}

/** Every conflict copy in `notes`, newest first, with its original when it still exists. */
export function findConflictPairs<T extends NoteRef>(notes: readonly T[]): ConflictPair<T>[] {
  const byPath = new Map(notes.map((n) => [n.path, n]));
  const pairs: ConflictPair<T>[] = [];
  for (const note of notes) {
    const parsed = parseConflictCopyPath(note.path);
    if (!parsed) continue;
    pairs.push({ copy: note, original: byPath.get(parsed.originalPath) ?? null, stamp: parsed.stamp });
  }
  return pairs.sort((x, y) => (x.stamp < y.stamp ? 1 : x.stamp > y.stamp ? -1 : 0));
}
