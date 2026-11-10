import { useId, useMemo, useState } from "react";

import { changedLineCount, diffLines } from "../lib/syncUi/diff";

export type NoteChoice = "mine" | "theirs" | "merged";

interface Props {
  /** The note as it is now on the server (the version that was kept). */
  theirs: string;
  /** The conflict copy: the version that could not be merged. */
  mine: string;
  originalPath: string;
  copyPath: string;
  saving?: boolean;
  error?: string | null;
  /** Save `text` into the original (revision-checked by the caller), then delete the copy. */
  onResolve: (choice: NoteChoice, text: string) => void;
}

/**
 * Resolve a note conflict (SYNC-11a-3). The note kept the version the server had; the version that
 * could not be merged was saved next to it as a conflict copy. Both are shown with an inline line
 * diff, and the person keeps mine, keeps theirs or merges the two in one text. The caller writes the
 * result into the original and only then deletes the copy, so no version is lost on the way.
 */
export function NoteConflictResolver({ theirs, mine, originalPath, copyPath, saving = false, error = null, onResolve }: Props) {
  const id = useId();
  const [merging, setMerging] = useState(false);
  const [merged, setMerged] = useState(theirs);
  const diff = useMemo(() => diffLines(theirs, mine), [theirs, mine]);
  const changes = changedLineCount(diff);

  return (
    <section className="note-conflict" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>Two versions of this note</h2>
      <p className="muted">
        <strong>{originalPath}</strong> kept the version that was on the server. Your other version was saved as{" "}
        <strong>{copyPath}</strong>. {changes === 0 ? "The two texts are identical." : `${changes} ${changes === 1 ? "line differs" : "lines differ"}.`}
      </p>
      <div className="note-diff" role="group" aria-label="Differences, theirs to mine">
        {diff.length === 0 ? <p className="muted">Both are empty.</p> : null}
        {diff.map((line, index) => (
          <div key={index} className={`note-diff-line is-${line.kind}`}>
            <span className="note-diff-mark" aria-hidden="true">
              {line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}
            </span>
            {line.kind !== "same" ? <span className="sr-only">{line.kind === "added" ? "Only in mine: " : "Only in theirs: "}</span> : null}
            <span className="note-diff-text">{line.text === "" ? " " : line.text}</span>
          </div>
        ))}
      </div>
      {merging ? (
        <div className="text-conflict-merge">
          <label htmlFor={`${id}-merged`}>Merged note text</label>
          <textarea id={`${id}-merged`} className="note-merge-editor" rows={12} value={merged} onChange={(e) => setMerged(e.target.value)} spellCheck={false} />
        </div>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="task-notice-actions">
        <button type="button" disabled={saving} onClick={() => onResolve("mine", mine)}>
          Keep mine
        </button>
        <button type="button" disabled={saving} onClick={() => onResolve("theirs", theirs)}>
          Keep theirs
        </button>
        {merging ? (
          <button type="button" className="primary" disabled={saving} onClick={() => onResolve("merged", merged)}>
            Save merged note
          </button>
        ) : (
          <button type="button" disabled={saving} onClick={() => setMerging(true)}>
            Merge in the editor
          </button>
        )}
      </div>
      <p className="muted">The conflict copy is moved to the trash after the note is saved. Nothing is deleted before that.</p>
    </section>
  );
}
