import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { ApiError, notesApi, ttrpgApi, type CampaignNote, type NoteDetail } from "../../api/client";
import { useNoteAutosave } from "../../hooks/useNoteAutosave";
import { readEditorMode } from "../../lib/notesPrefs";
import { NoteEditor } from "../NoteEditor";

const GROUPS: { kind: CampaignNote["kind"]; title: string }[] = [
  { kind: "home", title: "Campaign home" },
  { kind: "session", title: "Sessions" },
  { kind: "npc", title: "NPCs" },
  { kind: "location", title: "Locations" },
  { kind: "other", title: "Other notes" },
];

/**
 * The campaign's notes, collected and editable in place. They are ordinary notes that stay in the
 * notes tree beside every other note; here they are grouped by kind and open in an editor without
 * leaving the campaign. A quick form adds an NPC, a location or a plain note.
 */
export function CampaignNotes({ campaignId, archived, refreshKey }: { campaignId: string; archived: boolean; refreshKey: unknown }) {
  const [notes, setNotes] = useState<CampaignNote[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [kind, setKind] = useState<"npc" | "location" | "note">("npc");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = (await ttrpgApi.campaignNotes(campaignId)).items;
      setNotes(list);
      setSelected((current) =>
        current && list.some((note) => note.id === current) ? current : (list.find((n) => n.kind === "home") ?? list[0])?.id ?? null,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the notes");
    }
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await ttrpgApi.createCampaignNote(campaignId, { kind, title: title.trim() });
      setTitle("");
      await load();
      setSelected(created.id);
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Could not add the note");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="ttrpg-notes-title" className="tt-card">
      <h2 id="ttrpg-notes-title">Notes</h2>
      <p className="muted">
        Everything you have written for this campaign, in one place. They are your normal notes and stay in your notes
        folder next to all the others.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notes === null ? (
        <p className="muted">Loading notes…</p>
      ) : (
        <div className="tt-notes">
          <nav className="tt-notes-nav" aria-label="Campaign notes">
            {GROUPS.map(({ kind: groupKind, title: groupTitle }) => {
              const items = notes.filter((note) => note.kind === groupKind);
              if (items.length === 0) return null;
              return (
                <div key={groupKind} role="group" aria-label={groupTitle}>
                  <h3>{groupTitle}</h3>
                  <ul>
                    {items.map((note) => (
                      <li key={note.id}>
                        <button
                          type="button"
                          className="tt-note-pick"
                          aria-current={note.id === selected ? "true" : undefined}
                          onClick={() => setSelected(note.id)}
                        >
                          {note.label ?? note.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </nav>
          <NoteWorkspace noteId={selected} />
        </div>
      )}
      {!archived && (
        <form className="tt-form" onSubmit={(event) => void add(event)}>
          <label>
            New note
            <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="npc">NPC</option>
              <option value="location">Location</option>
              <option value="note">Other note</option>
            </select>
          </label>
          <label>
            Title
            <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <button type="submit" disabled={busy || !title.trim()}>
            Add note
          </button>
        </form>
      )}
    </section>
  );
}

function NoteWorkspace({ noteId }: { noteId: string | null }) {
  const [note, setNote] = useState<NoteDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!noteId) {
      setNote(null);
      return;
    }
    let cancelled = false;
    setError(null);
    notesApi
      .get(noteId)
      .then((loaded) => !cancelled && setNote(loaded))
      .catch(() => {
        if (!cancelled) {
          setNote(null);
          setError("That note could not be opened.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  const { session, snapshot } = useNoteAutosave(note);

  if (error) {
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  }
  if (!note) return <p className="tt-empty">Choose a note to read or edit it here.</p>;
  return (
    <div className="tt-note-editor">
      <div className="tt-row" style={{ justifyContent: "space-between" }}>
        <strong>{note.title}</strong>
        <Link to={`/notes?open=${note.id}`}>Open in Notes</Link>
      </div>
      <NoteEditor key={note.id} value={snapshot?.content ?? note.content} onChange={(text) => session?.change(text)} mode={readEditorMode()} />
    </div>
  );
}
