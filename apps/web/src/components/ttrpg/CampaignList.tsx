import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { ApiError, ttrpgApi, type TtrpgCampaign } from "../../api/client";
import { EmptyState } from "../EmptyState";
import { LoadError } from "../LoadError";
import { Skeleton } from "../Skeleton";

function message(err: unknown, fallback: string): string {
  return err instanceof ApiError || err instanceof Error ? err.message : fallback;
}

/** The campaigns of the signed-in owner, with a form to start one. */
export function CampaignList() {
  const [items, setItems] = useState<TtrpgCampaign[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems((await ttrpgApi.campaigns(showArchived)).items);
    } catch (err) {
      setError(message(err, "Could not load campaigns"));
    }
  }, [showArchived]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="page ttrpg-page">
      <h1>TTRPG</h1>
      <p>
        <Link to="/ttrpg/creatures">Creature library</Link>
      </p>
      <NewCampaign onCreated={load} />
      <label className="settings-switch">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(event) => setShowArchived(event.target.checked)}
        />
        Show archived
      </label>
      {error ? (
        <LoadError message={error} onRetry={() => void load()} />
      ) : items === null ? (
        <Skeleton label="Loading campaigns" rows={3} kind="line" />
      ) : items.length === 0 ? (
        <EmptyState icon="dices">
          No campaigns yet. Start one above: Atlas creates a home note and a first session note in
          your notes folder.
        </EmptyState>
      ) : (
        <ul className="ttrpg-campaigns">
          {items.map((campaign) => (
            <li key={campaign.id}>
              <Link to={`/ttrpg/${campaign.id}`}>{campaign.title}</Link>
              {campaign.book_title && <span className="muted"> · {campaign.book_title}</span>}
              {campaign.archived && <span className="muted"> · archived</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function NewCampaign({ onCreated }: { onCreated: () => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [book, setBook] = useState("");
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One id per attempt: pressing the button again after a failure retries the SAME create, so a
  // half-finished scaffold is completed instead of duplicated.
  const attempt = useRef<string>(crypto.randomUUID());

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await ttrpgApi.createCampaign({
        id: attempt.current,
        title,
        book_title: book.trim() || null,
        folder: folder.trim() || null,
      });
      attempt.current = crypto.randomUUID();
      setTitle("");
      setBook("");
      setFolder("");
      await onCreated();
    } catch (err) {
      setError(message(err, "Could not create the campaign"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="ttrpg-new" onSubmit={(event) => void submit(event)}>
      <h2>New campaign</h2>
      <label>
        Title
        <input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={200} />
      </label>
      <label>
        Book (optional)
        <input value={book} onChange={(event) => setBook(event.target.value)} maxLength={200} />
      </label>
      <label>
        Note folder (optional)
        <input
          value={folder}
          onChange={(event) => setFolder(event.target.value)}
          placeholder="TTRPG/<title>"
        />
      </label>
      <p className="muted">Rules preset: D&amp;D 5e (2014)</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy || !title.trim()}>
        {busy ? "Creating…" : "Create campaign"}
      </button>
    </form>
  );
}
