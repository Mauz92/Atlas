import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import {
  ttrpgApi,
  type EncounterSummary,
  type RunSummary,
  type TtrpgCampaignDetail,
} from "../../api/client";

/** The campaign's prepared encounters, with a quick way to start one. */
export function EncountersPanel({ campaign }: { campaign: TtrpgCampaignDetail }) {
  const [items, setItems] = useState<EncounterSummary[] | null>(null);
  const [unfinished, setUnfinished] = useState<RunSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const attempt = useRef(crypto.randomUUID());

  const load = useCallback(async () => {
    try {
      setItems((await ttrpgApi.encounters(campaign.id)).items);
      setUnfinished((await ttrpgApi.runs(campaign.id, true)).items[0] ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load encounters");
    }
  }, [campaign.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await ttrpgApi.createEncounter(campaign.id, { id: attempt.current, title: title.trim() });
      attempt.current = crypto.randomUUID();
      setTitle("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the encounter");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="ttrpg-encounters-title" className="tt-card">
      <h2 id="ttrpg-encounters-title">Encounters</h2>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {unfinished && (
        <p role="status" className="ttrpg-unfinished">
          A fight is not finished: <Link to={`/ttrpg/runs/${unfinished.id}`}>{unfinished.title}</Link>{" "}
          ({unfinished.status}
          {unfinished.round > 0 ? `, round ${unfinished.round}` : ""}). Resume it.
        </p>
      )}
      {items && items.length === 0 && <p className="muted">No encounters prepared yet.</p>}
      <ul>
        {items?.map((item) => (
          <li key={item.id}>
            <Link to={`/ttrpg/encounters/${item.id}`}>{item.title}</Link>
            <span className="muted">
              {" "}
              · {item.slot_count} combatant{item.slot_count === 1 ? "" : "s"}
              {item.book_reference ? ` · ${item.book_reference}` : ""}
            </span>
          </li>
        ))}
      </ul>
      {!campaign.archived && (
        <form className="tt-row" onSubmit={(event) => void create(event)}>
          <label>
            New encounter
            <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <button type="submit" disabled={busy || !title.trim()}>
            Prepare encounter
          </button>
        </form>
      )}
    </section>
  );
}
