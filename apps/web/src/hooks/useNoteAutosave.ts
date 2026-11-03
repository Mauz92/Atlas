import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { notesApi, type NoteDetail } from "../api/client";
import {
  NoteSessions,
  type NoteAutosave,
  type NoteSnapshot,
  type NoteStore,
  type SavedListener,
} from "../lib/noteAutosave";
import { localStorageDraftStore } from "../lib/noteDrafts";

/** The web host's wiring of the framework-free engine (`lib/noteAutosave.ts`, ADR-0054). */
export const noteStore: NoteStore<NoteDetail> = {
  update: (id, content, baseRevision, options) => notesApi.update(id, content, baseRevision, options),
  read: (id) => notesApi.get(id),
  reconcile: async () => {
    await notesApi.reconcile();
  },
  saveConflictCopy: async (id, content) => {
    const copy = await notesApi.saveConflictCopy(id, content);
    return { path: copy.path };
  },
};

const drafts = localStorageDraftStore();
export const noteSessions = new NoteSessions();

let listening = false;
function listenOnce() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  // Leaving or hiding the page is a flush point; keepalive lets the request outlive the page.
  window.addEventListener("pagehide", () => void noteSessions.flushAll(true));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void noteSessions.flushAll(true);
  });
  window.addEventListener("online", () => noteSessions.online());
}

const isOnline = () => (typeof navigator === "undefined" ? true : navigator.onLine);

/** Open (or rejoin) the save session of a note; `null` while no note is open. */
export function openNoteSession(note: NoteDetail): NoteAutosave<NoteDetail> {
  listenOnce();
  return noteSessions.open({ note, store: noteStore, drafts, isOnline }) as NoteAutosave<NoteDetail>;
}

const EMPTY: NoteSnapshot<NoteDetail> | null = null;
const noSubscribe = () => () => undefined;
const noSnapshot = () => EMPTY;

/**
 * Binds the Notes page to the save session of the open note. The session is shared per note and
 * outlives the editor while it holds unsaved text. `onSaved` fires after every server-confirmed
 * version (a save, or reloading the server's version).
 */
export function useNoteAutosave(
  note: NoteDetail | null,
  onSaved?: SavedListener<NoteDetail>,
): { session: NoteAutosave<NoteDetail> | null; snapshot: NoteSnapshot<NoteDetail> | null } {
  const noteId = note?.id ?? null;
  const first = useRef(note);
  first.current = note;
  // Opening is idempotent per note id, so computing it during render is safe (StrictMode, remounts).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const session = useMemo(() => (first.current ? openNoteSession(first.current) : null), [noteId]);
  const snapshot = useSyncExternalStore(
    session ? session.subscribe : noSubscribe,
    session ? session.getSnapshot : noSnapshot,
  );

  useEffect(() => {
    if (!session) return undefined;
    return () => noteSessions.release(session);
  }, [session]);

  const saved = useRef(onSaved);
  saved.current = onSaved;
  useEffect(
    () => (session ? session.onSaved((version) => saved.current?.(version)) : undefined),
    [session],
  );

  // Text restored from a draft is sent once the listener above is in place.
  useEffect(() => session?.resume(), [session]);

  // A newer copy of the note from outside (a rename) is adopted when nothing local is pending.
  useEffect(() => {
    if (session && note) session.adopt(note);
  }, [session, note]);

  return { session, snapshot };
}
