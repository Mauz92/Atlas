import { useCallback, useState } from "react";

import { ApiError, notesApi, type NoteDetail, type NoteSummary } from "../api/client";
import { findConflictPairs } from "../lib/syncUi/conflictCopies";
import { Icon } from "./Icon";
import { NoteConflictResolver, type NoteChoice } from "./NoteConflictResolver";

interface Props {
  notes: readonly NoteSummary[];
  /** The list changed (a copy was deleted, a note saved): read it again. */
  onChanged: () => void | Promise<void>;
  onOpen: (id: string) => void;
}

interface Open {
  copy: NoteDetail;
  original: NoteDetail;
}

/**
 * Conflict copies of notes (SYNC-11a-3): lists every `<name> (conflict ...).md` with its original and
 * opens the resolver. Writes go through the existing endpoints only: the original is saved with its
 * revision (`PUT /api/notes/{id}`, a `409` rereads it and shows the newer text instead of overwriting),
 * and the copy is deleted (to the trash) only after that save was acknowledged.
 */
export function NoteConflicts({ notes, onChanged, onOpen }: Props) {
  const pairs = findConflictPairs(notes);
  const [open, setOpen] = useState<Open | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const start = useCallback(async (copyId: string, originalId: string) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const [copy, original] = await Promise.all([notesApi.get(copyId), notesApi.get(originalId)]);
      setOpen({ copy, original });
    } catch {
      setError("Could not open the two versions. Try again.");
    } finally {
      setBusy(false);
    }
  }, []);

  const resolve = useCallback(
    async (choice: NoteChoice, text: string) => {
      if (!open) return;
      setBusy(true);
      setError(null);
      try {
        if (choice !== "theirs" && text !== open.original.content) {
          await notesApi.update(open.original.id, text, open.original.revision);
        }
        // the original holds the chosen text (or already did): only now does the copy go
        try {
          await notesApi.remove(open.copy.id);
        } catch {
          setError("The note is saved, but the conflict copy could not be deleted. Nothing was lost; delete the copy from the note list.");
          await onChanged();
          return;
        }
        setOpen(null);
        setDone(
          choice === "mine"
            ? "Your version is now the note. The conflict copy was moved to the trash."
            : choice === "theirs"
              ? "The note keeps the other version. The conflict copy was moved to the trash."
              : "The merged text is saved. The conflict copy was moved to the trash.",
        );
        await onChanged();
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          // the note moved on while the resolver was open: show the newer text, delete nothing
          try {
            const fresh = await notesApi.get(open.original.id);
            setOpen({ copy: open.copy, original: fresh });
          } catch {
            // the generic message below is enough
          }
          setError("The note changed again while you were choosing. The newer text is shown now; nothing was overwritten or deleted.");
        } else {
          setError("Could not save. Nothing was deleted. Try again.");
        }
      } finally {
        setBusy(false);
      }
    },
    [open, onChanged],
  );

  if (pairs.length === 0 && !done) return null;

  return (
    <section className="note-conflicts" aria-label="Note conflicts">
      {pairs.length > 0 ? (
        <>
          <p className="note-conflicts-title">
            <Icon name="git-merge" size={16} />
            <strong>{pairs.length === 1 ? "1 note has two versions" : `${pairs.length} notes have two versions`}</strong>
          </p>
          <ul className="note-conflict-list">
            {pairs.map(({ copy, original }) => (
              <li key={copy.id}>
                <span className="note-conflict-name">{copy.path}</span>
                {original ? (
                  <button type="button" aria-label={`Resolve ${copy.path}`} disabled={busy} onClick={() => void start(copy.id, original.id)}>
                    Resolve
                  </button>
                ) : (
                  <>
                    <span className="muted">The original is gone.</span>
                    <button type="button" aria-label={`Open ${copy.path}`} onClick={() => onOpen(copy.id)}>
                      Open
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {done ? (
        <p role="status" className="note-conflicts-done">
          {done}
        </p>
      ) : null}
      {open ? (
        <NoteConflictResolver
          key={`${open.original.id}:${open.original.revision}`}
          theirs={open.original.content}
          mine={open.copy.content}
          originalPath={open.original.path}
          copyPath={open.copy.path}
          saving={busy}
          error={error}
          onResolve={(choice, text) => void resolve(choice, text)}
        />
      ) : error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
