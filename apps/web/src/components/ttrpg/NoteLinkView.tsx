import { useState } from "react";
import { Link } from "react-router-dom";

import { notesApi, type NoteSummary, type TtrpgNoteLink } from "../../api/client";

interface Props {
  link: TtrpgNoteLink;
  /** Shown when the note was deleted; recreates it at its standard path. */
  onRecreate?: () => void;
  /** Shown when the note was deleted; links an existing note instead. */
  onLinkExisting?: (noteId: string) => void;
  busy?: boolean;
}

/** A campaign or session note: a link to the note, or the missing state with repair actions. */
export function NoteLinkView({ link, onRecreate, onLinkExisting, busy }: Props) {
  const [choosing, setChoosing] = useState(false);
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [choice, setChoice] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!link.missing && link.note_id) {
    return (
      <Link to={`/notes?open=${link.note_id}`} className="ttrpg-note-link">
        {link.title || link.path}
      </Link>
    );
  }

  async function open() {
    setChoosing(true);
    setError(null);
    try {
      setNotes((await notesApi.list()).notes);
    } catch {
      setError("Could not load your notes");
    }
  }

  return (
    <span className="ttrpg-note-missing" role="status">
      <span className="muted">Note missing</span>
      {onRecreate && (
        <button type="button" className="ghost" disabled={busy} onClick={onRecreate}>
          Recreate note
        </button>
      )}
      {onLinkExisting && !choosing && (
        <button type="button" className="ghost" disabled={busy} onClick={() => void open()}>
          Link another note
        </button>
      )}
      {onLinkExisting && choosing && (
        <span className="ttrpg-row">
          <select aria-label="Note to link" value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value="">Choose a note…</option>
            {(notes ?? []).map((note) => (
              <option key={note.id} value={note.id}>
                {note.path}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy || !choice}
            onClick={() => {
              onLinkExisting(choice);
              setChoosing(false);
              setChoice("");
            }}
          >
            Link this note
          </button>
          <button type="button" className="ghost" onClick={() => setChoosing(false)}>
            Cancel
          </button>
          {error && <span className="error">{error}</span>}
        </span>
      )}
    </span>
  );
}
