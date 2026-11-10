import { useId, useState } from "react";

export type TextChoice = "mine" | "theirs" | "merged";

interface Props {
  /** The field in words: "title", "description". */
  label: string;
  mine: string;
  theirs: string;
  multiline?: boolean;
  saving?: boolean;
  error?: string | null;
  /** Called with the text to save and which choice produced it. Nothing is sent until this is chosen. */
  onResolve: (text: string, choice: TextChoice) => void;
}

/**
 * Two versions of one text field, both kept on screen (SYNC-11a-2, AGENTS.md 8/9): this device's
 * version and the other device's, with three ways out: keep mine, keep theirs, or edit one merged
 * text. The component only reports the chosen text; the caller saves it as an ordinary
 * revision-checked write and the other version stays visible until that write is acknowledged.
 */
export function TextConflictResolver({ label, mine, theirs, multiline = false, saving = false, error = null, onResolve }: Props) {
  const id = useId();
  const [merging, setMerging] = useState(false);
  const [merged, setMerged] = useState(mine);
  const same = mine === theirs;

  return (
    <fieldset className="text-conflict" aria-describedby={`${id}-hint`} disabled={saving}>
      <legend>Two versions of the {label}</legend>
      <p id={`${id}-hint`} className="muted">
        {same ? "Both versions are now the same." : "Choose one, or combine them. Nothing is saved until you choose."}
      </p>
      <div className="text-conflict-versions">
        <div>
          <span className="text-conflict-label" id={`${id}-mine`}>Mine</span>
          <p className="text-conflict-text" aria-labelledby={`${id}-mine`} data-multiline={multiline || undefined}>
            {mine === "" ? <em>empty</em> : mine}
          </p>
        </div>
        <div>
          <span className="text-conflict-label" id={`${id}-theirs`}>Theirs</span>
          <p className="text-conflict-text" aria-labelledby={`${id}-theirs`} data-multiline={multiline || undefined}>
            {theirs === "" ? <em>empty</em> : theirs}
          </p>
        </div>
      </div>
      {merging ? (
        <div className="text-conflict-merge">
          <label htmlFor={`${id}-merged`}>Merged {label}</label>
          {multiline ? (
            <textarea id={`${id}-merged`} rows={6} value={merged} onChange={(e) => setMerged(e.target.value)} />
          ) : (
            <input id={`${id}-merged`} type="text" value={merged} onChange={(e) => setMerged(e.target.value)} />
          )}
        </div>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="task-notice-actions">
        <button type="button" aria-label={`Keep mine: ${label}`} onClick={() => onResolve(mine, "mine")}>
          Keep mine
        </button>
        <button type="button" aria-label={`Keep theirs: ${label}`} onClick={() => onResolve(theirs, "theirs")}>
          Keep theirs
        </button>
        {merging ? (
          <button type="button" className="primary" onClick={() => onResolve(merged, "merged")} disabled={label === "title" && merged.trim() === ""}>
            Save merged {label}
          </button>
        ) : (
          <button type="button" aria-label={`Edit merged ${label}`} onClick={() => { setMerged(multiline && mine !== theirs ? `${mine}\n\n${theirs}` : mine); setMerging(true); }}>
            Edit merged
          </button>
        )}
      </div>
    </fieldset>
  );
}
