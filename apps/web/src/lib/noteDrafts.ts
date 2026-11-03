import type { DraftStore, NoteDraft } from "./noteAutosave";

/**
 * Unsaved note text kept in this browser (UX-05, ADR-0054). The engine (`noteAutosave.ts`) only
 * knows the `DraftStore` interface; this is the web implementation over `localStorage`, one key per
 * note id. Every call is guarded: storage can be full, blocked or missing (private windows).
 *
 * A draft exists only while a note has text the server has not confirmed, so the store is normally
 * empty. Sign-out flushes sessions first and deliberately does not delete drafts that could not be
 * saved: losing the user's text is worse than leaving it (RISKS.md R-23).
 */
export const DRAFT_PREFIX = "atlas:note-draft:";

function isDraft(value: unknown): value is NoteDraft {
  const draft = value as Partial<NoteDraft> | null;
  return (
    typeof draft === "object" &&
    draft !== null &&
    typeof draft.content === "string" &&
    typeof draft.baseRevision === "number" &&
    typeof draft.savedAt === "number" &&
    (draft.attempted === undefined || typeof draft.attempted === "string")
  );
}

export function localStorageDraftStore(storage?: Storage): DraftStore {
  const area = () => {
    try {
      return storage ?? window.localStorage;
    } catch {
      return null;
    }
  };
  return {
    read(id) {
      try {
        const raw = area()?.getItem(DRAFT_PREFIX + id);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        return isDraft(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    write(id, draft) {
      try {
        area()?.setItem(DRAFT_PREFIX + id, JSON.stringify(draft));
      } catch {
        // Quota or blocked storage: saving to the server still works.
      }
    },
    clear(id) {
      try {
        area()?.removeItem(DRAFT_PREFIX + id);
      } catch {
        // Nothing to do.
      }
    },
  };
}
