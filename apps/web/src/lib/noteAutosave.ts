/**
 * Note autosave engine (UX-05, ADR-0054). Framework-free: no React, no DOM, no `window`.
 *
 * Everything the engine needs from its host is injected, so the same code runs in the web app now
 * and in the planned native desktop client later (Obsidian style, syncing with the Atlas server):
 *
 * - `NoteStore`  — how a version is read and written (the web app wraps `notesApi`);
 * - `DraftStore` — where unsaved text is kept on this device (the web app uses `localStorage`
 *                  behind `lib/noteDrafts.ts`; a desktop client would use a file or SQLite);
 * - `isOnline`, `now`, and the global timer functions (`setTimeout`), which exist in browsers,
 *   Node and Electron alike.
 *
 * One `NoteAutosave` session exists per open note. It turns edits into `PUT /api/notes/{id}`
 * requests with these guarantees (docs/MARKDOWN_STORAGE.md §4, AGENTS.md §8):
 *
 * - **A local draft is written synchronously on every change** and cleared only after the server
 *   confirmed exactly that text, so a reload, a crash or an offline stretch never loses typing.
 * - **One request at a time.** Edits typed while a request is in flight are coalesced; the next
 *   request carries the newest text and the revision the previous answer returned.
 * - **Never overwrite.** Every request carries `base_revision`. A `409` stops the session: the text
 *   stays in the editor, nothing more is sent, and the user chooses *keep mine as a copy* or *reload
 *   the server's version* (conflict copies are written by the server, never by overwriting).
 * - **Unknown outcomes are retried, then verified.** A network failure or `5xx` may have been applied
 *   by the server. The note `PUT` has no idempotency key, so the same body is re-sent; if that
 *   answers `409` (it was applied the first time) the note is re-read and counts as saved when the
 *   server's text equals the text that was sent. Different text is a genuine conflict.
 * - **Offline** nothing is sent; the draft holds the text; the `online()` call resumes.
 */

/** The part of a note the engine needs. A host may pass richer objects (they are handed back). */
export interface NoteVersion {
  id: string;
  revision: number;
  content: string;
}

export interface NoteUpdateOptions {
  /** The request is made while the page is going away and must be allowed to finish. */
  keepalive?: boolean;
}

export interface NoteStore<V extends NoteVersion = NoteVersion> {
  /**
   * Replace the note's text if the server still holds `baseRevision`. Rejects with an object that
   * has a numeric `status` (HTTP status) when the server answered, and with anything else when no
   * answer arrived (network failure).
   */
  update(id: string, content: string, baseRevision: number, options: NoteUpdateOptions): Promise<V>;
  /** The server's current version. */
  read(id: string): Promise<V>;
  /**
   * Optional. Bring the server's index up to date with the files on disk, so a note edited by
   * another program has its new revision before it is read. Called before reading a version to
   * resolve a conflict; a failure is ignored (the read still happens).
   */
  reconcile?(): Promise<void>;
  /** Write `content` as a conflict copy next to the note; the note itself is untouched. */
  saveConflictCopy(id: string, content: string): Promise<{ path: string }>;
}

/** Unsaved text kept on this device. */
export interface NoteDraft {
  content: string;
  /** The revision the text was typed on top of. */
  baseRevision: number;
  /** Epoch milliseconds of the last change. */
  savedAt: number;
  /**
   * The text of a request that was sent and may have been applied without the answer arriving. A
   * server holding exactly this text is a state this draft was built on (see `restoreDraft`).
   */
  attempted?: string;
}

/**
 * Synchronous on purpose: the draft must be on disk before a keystroke returns, and a page that is
 * being unloaded cannot wait for an asynchronous write. Implementations swallow their own storage
 * errors; the engine also guards every call.
 */
export interface DraftStore {
  read(id: string): NoteDraft | null;
  write(id: string, draft: NoteDraft): void;
  clear(id: string): void;
}

/** Drafts held in memory (tests, and a host with no storage). */
export function memoryDraftStore(): DraftStore & { entries: Map<string, NoteDraft> } {
  const entries = new Map<string, NoteDraft>();
  return {
    entries,
    read: (id) => entries.get(id) ?? null,
    write: (id, draft) => void entries.set(id, { ...draft }),
    clear: (id) => void entries.delete(id),
  };
}

export type SaveState =
  | "saved"
  | "saving"
  | "unsaved"
  | "offline"
  | "failed"
  | "rejected"
  | "conflict";

/** Wording for the indicator, kept with the states so every host says the same thing. */
export const SAVE_LABELS: Record<SaveState, string> = {
  saved: "Saved",
  saving: "Saving…",
  unsaved: "Not saved yet",
  offline: "Offline — saved on this device",
  failed: "Couldn't save — kept on this device",
  rejected: "Not saved",
  conflict: "Conflict",
};

export interface NoteSnapshot<V extends NoteVersion = NoteVersion> {
  /** The last version the server confirmed (its revision is the next `base_revision`). */
  note: V;
  /** What the editor shows, including unsaved text. */
  content: string;
  state: SaveState;
  /** The text differs from the confirmed version. */
  dirty: boolean;
  /** Why the last attempt failed or was refused, in the server's words where there are some. */
  failure: string | null;
  /** The revision the server holds while the session is in conflict. */
  conflictRevision: number | null;
  /** Text from the local draft was put back when the note was opened. */
  restored: boolean;
}

export type SavedListener<V extends NoteVersion = NoteVersion> = (version: V) => void;

export interface AutosaveOptions<V extends NoteVersion = NoteVersion> {
  note: V;
  store: NoteStore<V>;
  drafts: DraftStore;
  /** Quiet time after the last keystroke before saving. */
  debounceMs?: number;
  isOnline?: () => boolean;
  now?: () => number;
}

export const DEFAULT_DEBOUNCE_MS = 1000;

/** What was (or may have been) sent: the body is fixed once built, so a retry repeats it exactly. */
interface Attempt {
  content: string;
  base: number;
}

function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** The server may or may not have applied the request: connection failure, timeout, 5xx, 429. */
function isUnknownOutcome(error: unknown): boolean {
  const status = statusOf(error);
  return status === null || status === 408 || status === 429 || status >= 500;
}

export class NoteAutosave<V extends NoteVersion = NoteVersion> {
  readonly id: string;
  disposed = false;

  private readonly store: NoteStore<V>;
  private readonly drafts: DraftStore;
  private readonly debounceMs: number;
  private readonly isOnline: () => boolean;
  private readonly now: () => number;

  private saved: V;
  private content: string;
  /** A request whose outcome is unknown; sent again before anything else. */
  private retrying: Attempt | null = null;
  private inFlight: Attempt | null = null;
  private conflictRevision: number | null = null;
  /** Text the server refused (4xx), with its message; not re-sent until the text changes. */
  private rejected: { content: string; message: string } | null = null;
  private failure: string | null = null;
  private restored = false;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private loop: Promise<void> | null = null;
  private keepalive = false;

  private readonly listeners = new Set<() => void>();
  private readonly savedListeners = new Set<SavedListener<V>>();
  private snapshot: NoteSnapshot<V>;

  constructor(options: AutosaveOptions<V>) {
    this.id = options.note.id;
    this.store = options.store;
    this.drafts = options.drafts;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.isOnline = options.isOnline ?? (() => true);
    this.now = options.now ?? (() => Date.now());
    this.saved = options.note;
    this.content = options.note.content;
    this.restoreDraft();
    this.snapshot = this.build();
  }

  // --- reading -----------------------------------------------------------------------------

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  readonly getSnapshot = (): NoteSnapshot<V> => this.snapshot;

  get listenerCount(): number {
    return this.listeners.size;
  }

  /** After every server-confirmed version (a save, a reload of the server's version). */
  onSaved(listener: SavedListener<V>): () => void {
    this.savedListeners.add(listener);
    return () => void this.savedListeners.delete(listener);
  }

  /** The text is not (yet) safely on the server, or the session cannot send it. */
  hasUnsaved(): boolean {
    return (
      this.content !== this.saved.content ||
      this.retrying !== null ||
      this.inFlight !== null ||
      this.conflictRevision !== null ||
      this.rejected !== null
    );
  }

  // --- editing -----------------------------------------------------------------------------

  /** The editor's text changed. */
  change(content: string): void {
    if (this.disposed || content === this.content) return;
    this.content = content;
    if (this.rejected && this.rejected.content !== content) this.rejected = null;
    this.failure = this.rejected ? this.failure : null;
    this.restored = false;
    this.writeDraft();
    if (this.conflictRevision === null) {
      if (this.needsSend()) this.schedule(this.debounceMs);
      else this.cancelTimer();
    }
    this.emit();
  }

  /**
   * Send everything now and wait. Resolves `true` when the server holds exactly the editor's text;
   * `false` when it could not be confirmed (offline, failed, refused, conflict). In every `false`
   * case the text is still in the session and in the draft.
   */
  async flush(options: { keepalive?: boolean } = {}): Promise<boolean> {
    this.cancelTimer();
    await this.run(options.keepalive === true);
    return !this.hasUnsaved();
  }

  /** Try again after a failure (the Retry button). */
  retry(): Promise<boolean> {
    if (this.rejected) this.rejected = null;
    return this.flush();
  }

  /**
   * Send text that was restored from a draft. The host calls this once it listens (`onSaved`,
   * `subscribe`), so the first answer cannot arrive before anyone is told. Safe to call any time.
   */
  resume(): void {
    if (!this.disposed && this.conflictRevision === null && this.needsSend()) this.schedule(0);
  }

  /** The device came back online. */
  online(): void {
    if (this.disposed || this.conflictRevision !== null || !this.needsSend()) return;
    void this.flush();
  }

  /**
   * A version from outside the session (a rename, a fresh read). Taken only when the session holds
   * nothing unsaved; otherwise the next save meets the revision check.
   */
  adopt(version: V): void {
    if (this.disposed || version.id !== this.id || this.hasUnsaved()) return;
    if (version.revision < this.saved.revision) return;
    if (version.revision === this.saved.revision && version.content === this.saved.content) {
      // Same text, maybe different metadata (links, tasks): the host sees the fresh object.
      this.saved = version;
      this.emit();
      return;
    }
    this.saved = version;
    this.content = version.content;
    this.clearDraft();
    this.failure = null;
    this.emit();
  }

  // --- conflict choices --------------------------------------------------------------------

  /** Write the editor's text as a conflict copy, then show the server's version. Returns the copy's path. */
  async keepMineAsCopy(): Promise<string> {
    const copy = await this.store.saveConflictCopy(this.id, this.content);
    await this.reloadFromServer();
    return copy.path;
  }

  /** Drop the local text and show the server's version. */
  async reloadFromServer(): Promise<V> {
    this.cancelTimer();
    await this.reconcile();
    const version = await this.store.read(this.id);
    this.saved = version;
    this.content = version.content;
    this.conflictRevision = null;
    this.retrying = null;
    this.rejected = null;
    this.failure = null;
    this.restored = false;
    this.clearDraft();
    this.emit();
    this.notifySaved(version);
    return version;
  }

  /** The note was deleted: forget the session and its draft. */
  abandon(): void {
    this.clearDraft();
    this.dispose();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
    this.listeners.clear();
    this.savedListeners.clear();
  }

  // --- sending -----------------------------------------------------------------------------

  private needsSend(): boolean {
    if (this.retrying) return true;
    if (this.content === this.saved.content) return false;
    return !(this.rejected && this.rejected.content === this.content);
  }

  private schedule(delay: number): void {
    this.cancelTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run(false);
    }, delay);
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private run(keepalive: boolean): Promise<void> {
    if (this.loop) return this.loop;
    this.keepalive = keepalive;
    this.loop = this.drain().finally(() => {
      this.loop = null;
      this.emit();
    });
    return this.loop;
  }

  /** The single send loop: at most one request in flight, always built from the newest text. */
  private async drain(): Promise<void> {
    while (!this.disposed && this.conflictRevision === null && this.needsSend()) {
      if (!this.isOnline()) {
        this.emit();
        return;
      }
      const attempt = this.retrying ?? { content: this.content, base: this.saved.revision };
      this.retrying = null;
      this.inFlight = attempt;
      this.writeDraft();
      this.emit();
      try {
        const version = await this.store.update(this.id, attempt.content, attempt.base, {
          keepalive: this.keepalive,
        });
        this.inFlight = null;
        this.confirm(version);
      } catch (error) {
        this.inFlight = null;
        if (!(await this.handleFailure(attempt, error))) return;
      }
    }
  }

  /** The server holds `version`. Returns nothing; the loop continues if more text is waiting. */
  private confirm(version: V): void {
    this.saved = version;
    this.failure = null;
    this.rejected = null;
    this.writeDraft();
    this.notifySaved(version);
  }

  /** Returns `true` when the loop may continue (the attempt turned out to be applied). */
  private async handleFailure(attempt: Attempt, error: unknown): Promise<boolean> {
    const status = statusOf(error);
    if (status === 409) {
      return this.resolveConflict(attempt, error);
    }
    if (isUnknownOutcome(error)) {
      this.retrying = attempt;
      this.failure = messageOf(error, "The server did not answer.");
      this.writeDraft();
      return false;
    }
    // 4xx: the server understood and refused. Keep the text, say why, send nothing more for it.
    this.rejected = { content: attempt.content, message: messageOf(error, "The server refused the change.") };
    this.failure = this.rejected.message;
    this.writeDraft();
    return false;
  }

  /**
   * A `409` is never an overwrite. First look at what the server holds: if it is exactly the text
   * we sent, an earlier try of this same request was applied and only its answer was lost.
   */
  private async resolveConflict(attempt: Attempt, error: unknown): Promise<boolean> {
    let server: V;
    try {
      await this.reconcile();
      server = await this.store.read(this.id);
    } catch (readError) {
      if (statusOf(readError) !== null && !isUnknownOutcome(readError)) {
        // The note cannot be read (deleted, moved away): a conflict we cannot inspect.
        this.conflictRevision = this.revisionFrom(error) ?? this.saved.revision;
        this.failure = messageOf(readError, "The note could not be read.");
        return false;
      }
      // Could not check: keep the request and look again later; nothing was overwritten.
      this.retrying = attempt;
      this.failure = messageOf(readError, "The server did not answer.");
      this.writeDraft();
      return false;
    }
    if (server.content === attempt.content) {
      this.confirm(server);
      return true;
    }
    this.conflictRevision = server.revision;
    this.failure = "This note changed elsewhere. Nothing was overwritten.";
    this.writeDraft();
    return false;
  }

  private async reconcile(): Promise<void> {
    try {
      await this.store.reconcile?.();
    } catch {
      // Best effort: the read that follows still shows what the server holds.
    }
  }

  private revisionFrom(error: unknown): number | null {
    const value = (error as { currentRevision?: unknown } | null)?.currentRevision;
    return typeof value === "number" ? value : null;
  }

  // --- draft -------------------------------------------------------------------------------

  private writeDraft(): void {
    if (this.content === this.saved.content && !this.retrying && !this.inFlight) {
      this.clearDraft();
      return;
    }
    const attempted = this.inFlight?.content ?? this.retrying?.content;
    const draft: NoteDraft = {
      content: this.content,
      baseRevision: this.saved.revision,
      savedAt: this.now(),
      ...(attempted !== undefined ? { attempted } : {}),
    };
    try {
      this.drafts.write(this.id, draft);
    } catch {
      // A full or blocked store must not stop saving to the server.
    }
  }

  private clearDraft(): void {
    try {
      this.drafts.clear(this.id);
    } catch {
      // Nothing to do.
    }
  }

  /**
   * Opening a note that has a draft from an earlier visit:
   * - same text as the server: the draft is stale, drop it;
   * - typed on top of the revision the server still holds (or on a state the server reached through
   *   our own possibly-applied request): put it back and save it; the revision check guards it;
   * - typed on top of an older revision: the server changed since. Never applied silently: the draft
   *   text is shown in conflict, with the usual choices.
   */
  private restoreDraft(): void {
    let draft: NoteDraft | null = null;
    try {
      draft = this.drafts.read(this.id);
    } catch {
      draft = null;
    }
    if (!draft) return;
    if (draft.content === this.saved.content) {
      this.clearDraft();
      return;
    }
    this.content = draft.content;
    this.restored = true;
    const sameBase = draft.baseRevision === this.saved.revision;
    const builtOnOwnRequest = draft.attempted !== undefined && draft.attempted === this.saved.content;
    if (!sameBase && !builtOnOwnRequest) {
      this.conflictRevision = this.saved.revision;
      this.failure = "This note changed elsewhere. Nothing was overwritten.";
    }
    if (this.conflictRevision === null) this.writeDraft();
  }

  // --- state -------------------------------------------------------------------------------

  private derive(): SaveState {
    if (this.conflictRevision !== null) return "conflict";
    if (this.inFlight) return "saving";
    if (this.rejected) return "rejected";
    if (this.retrying) return this.isOnline() ? "failed" : "offline";
    if (this.content !== this.saved.content) return this.isOnline() ? "unsaved" : "offline";
    return "saved";
  }

  private build(): NoteSnapshot<V> {
    return {
      note: this.saved,
      content: this.content,
      state: this.derive(),
      dirty: this.content !== this.saved.content,
      failure: this.failure,
      conflictRevision: this.conflictRevision,
      restored: this.restored,
    };
  }

  private emit(): void {
    const next = this.build();
    const previous = this.snapshot;
    if (
      previous &&
      previous.note === next.note &&
      previous.content === next.content &&
      previous.state === next.state &&
      previous.failure === next.failure &&
      previous.conflictRevision === next.conflictRevision &&
      previous.restored === next.restored
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }

  private notifySaved(version: V): void {
    for (const listener of [...this.savedListeners]) listener(version);
  }
}

/**
 * The sessions of one host, keyed by note id. A session with unsaved text outlives the editor that
 * showed it (navigating away, switching notes), so reopening the note shows that text and its state
 * instead of losing it; a clean session is dropped when released. The host calls `flushAll(true)` on
 * `pagehide`/hidden and `online()` when connectivity returns (see `hooks/useNoteAutosave.ts`).
 */
export class NoteSessions {
  private readonly live = new Map<string, NoteAutosave<NoteVersion>>();

  open<V extends NoteVersion>(options: AutosaveOptions<V>): NoteAutosave<V> {
    const existing = this.live.get(options.note.id) as NoteAutosave<V> | undefined;
    if (existing && !existing.disposed) {
      existing.adopt(options.note);
      return existing;
    }
    const session = new NoteAutosave(options);
    this.live.set(session.id, session as unknown as NoteAutosave<NoteVersion>);
    return session;
  }

  get(id: string): NoteAutosave<NoteVersion> | undefined {
    return this.live.get(id);
  }

  /** The editor showing `session` went away. A clean session is dropped; others flush and stay. */
  release<V extends NoteVersion>(session: NoteAutosave<V>): void {
    const drop = () => {
      if (session.listenerCount === 0 && !session.hasUnsaved()) {
        session.dispose();
        if (this.live.get(session.id) === (session as unknown)) this.live.delete(session.id);
      }
    };
    // Deferred, so an immediate remount (React StrictMode, a quick reopen) keeps the same session.
    queueMicrotask(() => {
      if (session.listenerCount > 0 || session.disposed) return;
      if (session.hasUnsaved()) void session.flush().then(drop);
      else drop();
    });
  }

  /** The note was deleted on the server. */
  forget(id: string): void {
    this.live.get(id)?.abandon();
    this.live.delete(id);
  }

  /** Flush every session that holds unsaved text (page hidden or closing: `keepalive`). */
  flushAll(keepalive: boolean): Promise<boolean[]> {
    const pending: Promise<boolean>[] = [];
    for (const session of this.live.values()) {
      if (session.hasUnsaved()) pending.push(session.flush({ keepalive }));
    }
    return Promise.all(pending);
  }

  /** Connectivity returned: sessions waiting to send resume. */
  online(): void {
    for (const session of this.live.values()) session.online();
  }

  /** Drop everything (tests, sign-out). Unsaved text stays in the draft store. */
  clear(): void {
    for (const session of this.live.values()) session.dispose();
    this.live.clear();
  }
}
