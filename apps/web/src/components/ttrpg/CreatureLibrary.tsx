import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import {
  ApiError,
  ttrpgApi,
  type Creature,
  type CreatureCard,
  type SrdSearch,
} from "../../api/client";
import { LoadError } from "../LoadError";

function message(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status === 409) {
    return "This changed elsewhere. It has been reloaded; try again.";
  }
  return err instanceof Error ? err.message : fallback;
}

const EMPTY: CreatureCard = { name: "", ac: 10, hp: 10, initiative_mod: 0, traits: [], actions: [] };

/** Creature cards: the owner's own, plus the optional SRD catalogue. */
export function CreatureLibrary() {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Creature[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems((await ttrpgApi.creatures(query)).items);
    } catch (err) {
      setError(message(err, "Could not load creatures"));
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(work: () => Promise<unknown>, failure: string): Promise<boolean> {
    setBusy(true);
    setActionError(null);
    try {
      await work();
      await load();
      return true;
    } catch (err) {
      setActionError(message(err, failure));
      await load();
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page ttrpg-page">
      <p>
        <Link to="/ttrpg">All campaigns</Link>
      </p>
      <h1>Creatures</h1>
      <label>
        Search your creatures
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {actionError && (
        <p className="error" role="alert">
          {actionError}
        </p>
      )}
      {error ? (
        <LoadError message={error} onRetry={() => void load()} />
      ) : items === null ? (
        <p className="muted">Loading creatures…</p>
      ) : items.length === 0 ? (
        <p className="muted">No creatures yet. Add one by hand or import one from the SRD below.</p>
      ) : (
        <ul className="ttrpg-creatures">
          {items.map((card) => (
            <li key={card.id}>
              <button
                type="button"
                className="ghost"
                aria-expanded={openId === card.id}
                onClick={() => setOpenId(openId === card.id ? null : card.id)}
              >
                {card.name}
              </button>
              <span className="muted">
                {" "}
                AC {card.ac} · HP {card.hp}
                {card.challenge_rating ? ` · CR ${card.challenge_rating}` : ""}
                {card.source === "srd" ? " · SRD" : card.derived_from_id ? " · variant" : ""}
              </span>
              {openId === card.id && <CreatureDetail card={card} busy={busy} act={act} />}
            </li>
          ))}
        </ul>
      )}
      <NewCreature onCreated={load} />
      <SrdSearchPanel onImported={load} />
    </section>
  );
}

function CreatureDetail({
  card,
  busy,
  act,
}: {
  card: Creature;
  busy: boolean;
  act: (work: () => Promise<unknown>, failure: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="ttrpg-creature-detail">
      <p>
        {[card.size, card.creature_type].filter(Boolean).join(" ")}
        {card.speed ? ` · speed ${card.speed}` : ""} · initiative {card.initiative_mod >= 0 ? "+" : ""}
        {card.initiative_mod}
      </p>
      {card.traits.map((trait) => (
        <p key={trait.name}>
          <strong>{trait.name}.</strong> {trait.text}
        </p>
      ))}
      {card.actions.map((action) => (
        <p key={`${action.kind}-${action.name}`}>
          <strong>{action.name}</strong>
          {action.kind !== "action" ? ` (${action.kind})` : ""}
          {action.to_hit != null ? ` +${action.to_hit} to hit` : ""}
          {action.damage ? ` · ${action.damage}` : ""}. {action.text}
        </p>
      ))}
      {card.attribution && <p className="muted ttrpg-attribution">{card.attribution}</p>}
      {editing && card.source === "manual" && (
        <CreatureForm
          initial={card}
          submitLabel="Save creature"
          busy={busy}
          onCancel={() => setEditing(false)}
          onSubmit={(fields) =>
            void act(() => ttrpgApi.updateCreature(card, fields), "Could not save").then(
              (ok) => ok && setEditing(false),
            )
          }
        />
      )}
      <div className="ttrpg-actions">
        {card.source === "manual" && (
          <button type="button" className="ghost" disabled={busy} onClick={() => setEditing(true)}>
            Edit {card.name}
          </button>
        )}
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={() => void act(() => ttrpgApi.duplicateCreature(card.id, crypto.randomUUID()), "Could not duplicate")}
        >
          Duplicate as variant
        </button>
        {card.source === "srd" && (
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() => void act(() => ttrpgApi.refreshCreature(card), "Could not refresh from the SRD")}
          >
            Refresh from SRD
          </button>
        )}
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={() => void act(() => ttrpgApi.archiveCreature(card, true), "Could not archive")}
        >
          Archive {card.name}
        </button>
      </div>
    </div>
  );
}

function CreatureForm({
  initial,
  submitLabel,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  initial?: CreatureCard;
  submitLabel: string;
  busy: boolean;
  error?: string | null;
  onSubmit: (card: CreatureCard) => void;
  onCancel?: () => void;
}) {
  const [card, setCard] = useState<CreatureCard>(initial ?? EMPTY);
  const [cr, setCr] = useState(initial?.challenge_rating ?? "");
  const [speed, setSpeed] = useState(initial?.speed ?? "");
  return (
    <form
      className="ttrpg-new"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy)
          onSubmit({ ...card, challenge_rating: cr.trim() || null, speed: speed.trim() || null });
      }}
    >
      <label>
        Name
        <input value={card.name} maxLength={120} required onChange={(e) => setCard({ ...card, name: e.target.value })} />
      </label>
      <label>
        AC
        <input type="number" min={0} max={40} required value={card.ac} onChange={(e) => setCard({ ...card, ac: Number(e.target.value) })} />
      </label>
      <label>
        HP
        <input type="number" min={1} max={9999} required value={card.hp} onChange={(e) => setCard({ ...card, hp: Number(e.target.value) })} />
      </label>
      <label>
        Initiative modifier
        <input type="number" min={-10} max={30} value={card.initiative_mod ?? 0} onChange={(e) => setCard({ ...card, initiative_mod: Number(e.target.value) })} />
      </label>
      <label>
        Speed
        <input value={speed} maxLength={200} onChange={(e) => setSpeed(e.target.value)} />
      </label>
      <label>
        Challenge rating
        <input value={cr} maxLength={8} placeholder="1/4" onChange={(e) => setCr(e.target.value)} />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="ttrpg-actions">
        <button type="submit" disabled={busy || !card.name.trim()}>
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function NewCreature({ onCreated }: { onCreated: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef(crypto.randomUUID());
  if (!open) {
    return (
      <p>
        <button type="button" onClick={() => setOpen(true)}>
          New creature
        </button>
      </p>
    );
  }
  return (
    <CreatureForm
      submitLabel="Create creature"
      busy={busy}
      error={error}
      onCancel={() => setOpen(false)}
      onSubmit={(card) => {
        setBusy(true);
        setError(null);
        ttrpgApi
          .createCreature({ ...card, id: attempt.current })
          .then(async () => {
            attempt.current = crypto.randomUUID();
            setOpen(false);
            await onCreated();
          })
          .catch((err) => setError(message(err, "Could not create the creature")))
          .finally(() => setBusy(false));
      }}
    />
  );
}

function SrdSearchPanel({ onImported }: { onImported: () => Promise<void> }) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SrdSearch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function search(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResult(await ttrpgApi.searchSrd(query));
    } catch (err) {
      setResult(null);
      setError(message(err, "Could not search the SRD"));
    } finally {
      setBusy(false);
    }
  }

  async function importOne(index: string) {
    setBusy(true);
    setError(null);
    try {
      await ttrpgApi.importSrd(index);
      await onImported();
      setResult(await ttrpgApi.searchSrd(query));
    } catch (err) {
      setError(message(err, "Could not import the creature"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="ttrpg-srd-title">
      <h2 id="ttrpg-srd-title">Add from the SRD</h2>
      <p className="muted">
        Searching the catalogue sends only the request for the monster list or one monster; nothing
        about your campaigns leaves Atlas.
      </p>
      <form className="ttrpg-row" onSubmit={(event) => void search(event)}>
        <label>
          Search the SRD
          <input value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <button type="submit" disabled={busy}>
          Search
        </button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <>
          <ul>
            {result.items.length === 0 && <li className="muted">No matches.</li>}
            {result.items.map((entry) => (
              <li key={entry.index}>
                {entry.name}{" "}
                {entry.imported_as ? (
                  <span className="muted">Imported</span>
                ) : (
                  <button type="button" disabled={busy} onClick={() => void importOne(entry.index)}>
                    Import {entry.name}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p className="muted ttrpg-attribution">{result.attribution}</p>
        </>
      )}
    </section>
  );
}
