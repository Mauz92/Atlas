import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { ApiError, ttrpgApi, type CampaignNote } from "../../api/client";

const GROUPS: { kind: CampaignNote["kind"]; title: string }[] = [
  { kind: "home", title: "Campaign home" },
  { kind: "session", title: "Sessions" },
  { kind: "npc", title: "NPCs" },
  { kind: "location", title: "Locations" },
  { kind: "other", title: "Other notes" },
];

/**
 * All of a campaign's notes in one place. They are ordinary notes and stay in the notes tree beside
 * every other note; this is the campaign's own view of them (and a quick way to add an NPC or a place).
 */
export function CampaignNotes({ campaignId, archived, refreshKey }: { campaignId: string; archived: boolean; refreshKey: unknown }) {
  const [notes, setNotes] = useState<CampaignNote[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<"npc" | "location" | "note">("npc");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setNotes((await ttrpgApi.campaignNotes(campaignId)).items);
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
      await ttrpgApi.createCampaignNote(campaignId, { kind, title: title.trim() });
      setTitle("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Could not add the note");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="ttrpg-notes-title" className="ttrpg-campaign-notes">
      <h2 id="ttrpg-notes-title">Notes</h2>
      <p className="muted">
        Everything you have written for this campaign. These are your normal notes; they stay in your notes
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
        GROUPS.map(({ kind: groupKind, title: groupTitle }) => {
          const items = notes.filter((note) => note.kind === groupKind);
          if (items.length === 0) return null;
          return (
            <div key={groupKind} role="group" aria-label={groupTitle}>
              <h3>{groupTitle}</h3>
              <ul>
                {items.map((note) => (
                  <li key={note.id}>
                    <Link to={`/notes?open=${note.id}`}>{note.label ?? note.title}</Link>
                    <span className="muted"> {note.path}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })
      )}
      {!archived && (
        <form className="ttrpg-row" onSubmit={(event) => void add(event)}>
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
