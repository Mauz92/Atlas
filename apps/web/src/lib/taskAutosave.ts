import { ApiError, type Task, type TaskFields, type TaskUpdateOptions } from "../api/client";
import { newIdempotencyKey } from "./offlineQueue";
import { changesFromDraft, draftFromTask, type TaskDraft } from "./taskForm";

/**
 * Per-field autosave for the task detail (UX-04, ADR-0053). Pure TypeScript, no React.
 *
 * One `TaskAutosave` session per open task holds what the fields show (`draft`), the last version
 * the server confirmed (`task`) and which property groups have unsaved edits. It turns edits into
 * `PATCH /api/tasks/{id}` requests with these guarantees:
 *
 * - **One request at a time per task.** Requests are sent by a single loop; a new edit while one is
 *   in flight is queued and goes out after it, with the revision the server just returned, so a fast
 *   typist never conflicts with their own previous save.
 * - **Coalescing.** The body is computed from the draft at *send* time, so ten keystrokes queued
 *   behind a request become one `PATCH` with the latest text.
 * - **One group per request.** A request carries one property group (title, description, status,
 *   priority, schedule = due/start/zone, tags, project, repeat), so a validation error names exactly
 *   the field that caused it and an invalid field never blocks the others.
 * - **Never overwrite.** Every request carries `base_revision`. A `409` with the server's revision is
 *   a conflict: nothing more is sent, the local values are kept, and the user chooses to load the
 *   latest version (the unsaved values are then set aside so they can be reapplied).
 * - **Never drop an edit silently.** A `422` (or another client error) keeps the text and shows the
 *   server's message; a network failure or `5xx` keeps the request and re-sends it with the **same**
 *   idempotency key and body on the next edit, flush, retry or `online` event, so a request that did
 *   reach the server is replayed, not applied twice.
 */

export type FieldGroup =
  | "title"
  | "description"
  | "status"
  | "priority"
  | "schedule"
  | "tags"
  | "project"
  | "repeat";

/** The draft fields each group owns; a group is always sent as one `PATCH`. */
export const GROUP_FIELDS: Record<FieldGroup, readonly (keyof TaskDraft)[]> = {
  title: ["title"],
  description: ["description"],
  status: ["status"],
  priority: ["priority"],
  // Date, time, zone and start jointly define instants, so they travel together (taskForm.ts).
  schedule: ["dueDate", "dueTime", "timeZone", "start"],
  tags: ["tags"],
  project: ["projectId"],
  repeat: ["recurrenceRule"],
};

const GROUPS = Object.keys(GROUP_FIELDS) as FieldGroup[];

/** User-facing names, for "not saved: …" lists. */
export const GROUP_LABELS: Record<FieldGroup, string> = {
  title: "Title",
  description: "Description",
  status: "Status",
  priority: "Priority",
  schedule: "Dates",
  tags: "Tags",
  project: "Project",
  repeat: "Repeat",
};

export function groupOf(field: keyof TaskDraft): FieldGroup {
  return GROUPS.find((group) => GROUP_FIELDS[group].includes(field))!;
}

/**
 * How an edit is saved: `debounce` (text: after a pause, or at the next flush), `now` (a choice from a
 * menu) or `hold` (only at the next flush, e.g. on blur: a half-typed rule or zone is not sent).
 */
export type EditMode = "debounce" | "now" | "hold";

/** What the header indicator shows. */
export type SaveState =
  | "saved"
  | "saving"
  | "unsaved"
  | "invalid"
  | "offline"
  | "failed"
  | "conflict";

export interface FieldError {
  message: string;
  /** Hidden while it came from a pause in typing; shown once the field is left or flushed. */
  shown: boolean;
}

export interface AutosaveSnapshot {
  /** The last version the server confirmed (its revision is the next `base_revision`). */
  task: Task;
  /** What the fields show, including unsaved edits. */
  draft: TaskDraft;
  state: SaveState;
  /** Groups with edits the server has not confirmed (queued, rejected, in flight or unconfirmed). */
  unsaved: readonly FieldGroup[];
  errors: Partial<Record<FieldGroup, FieldError>>;
  /** A failure that is not about one field (network, server error), in the server's words. */
  failure: string | null;
  conflict: boolean;
  /** Local values set aside by "Load latest version", so they can be reapplied. */
  stash: Partial<TaskDraft> | null;
}

export type SendUpdate = (
  task: Task,
  fields: TaskFields,
  options: Required<Pick<TaskUpdateOptions, "idempotencyKey">> & TaskUpdateOptions,
) => Promise<Task>;

export type SavedListener = (saved: Task, previous: Task) => void;

export interface AutosaveOptions {
  task: Task;
  send: SendUpdate;
  viewerZone?: string;
  debounceMs?: number;
  isOnline?: () => boolean;
  newKey?: () => string;
}

interface Request {
  groups: FieldGroup[];
  /** The fields the user had changed when the request was built (kept if it fails). */
  touched: (keyof TaskDraft)[];
  fields: TaskFields;
  /** The task as it was when the request was built (its revision is the `base_revision`). */
  base: Task;
  key: string;
}

export const DEFAULT_DEBOUNCE_MS = 600;

function isRevisionConflict(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.currentRevision !== null;
}

/** A client error the same request will keep getting (validation, a refused transition, 404). */
function isRejection(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status >= 400 &&
    err.status < 500 &&
    err.status !== 408 &&
    err.status !== 429
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "Something went wrong";
}

function pick(draft: TaskDraft, groups: Iterable<FieldGroup>): Partial<TaskDraft> {
  const out: Partial<TaskDraft> = {};
  for (const group of groups) {
    for (const field of GROUP_FIELDS[group]) {
      (out as Record<string, string>)[field] = draft[field];
    }
  }
  return out;
}

export class TaskAutosave {
  readonly taskId: string;
  private base: Task;
  private draft: TaskDraft;
  private readonly viewerZone: string | undefined;
  private readonly send: SendUpdate;
  private readonly debounceMs: number;
  private readonly isOnline: () => boolean;
  private readonly newKey: () => string;

  /** Groups waiting to be sent, in the order they were first edited. */
  private readonly dirty = new Set<FieldGroup>();
  private errors: Partial<Record<FieldGroup, FieldError>> = {};
  private failure: string | null = null;
  private offline = false;
  private conflict = false;
  private stash: Partial<TaskDraft> | null = null;
  /** The field that has focus: a save never replaces the text being typed there. */
  private focused: keyof TaskDraft | null = null;
  /**
   * Fields the user changed since their group's last request was built. After a save, every other
   * field takes the server's value (e.g. the zone the server pinned when a due date was set), even
   * in a group that still has a newer edit queued; touched fields keep what the user typed.
   */
  private readonly touched = new Set<keyof TaskDraft>();
  /** How each group was last edited: errors from a pause in typing wait for the field to be left. */
  private readonly lastMode = new Map<FieldGroup, EditMode>();

  private timer: ReturnType<typeof setTimeout> | null = null;
  private loop: Promise<void> | null = null;
  /** A kick arrived while the loop was finishing: run it once more so the edit is not stranded. */
  private wanted = false;
  private sending: Request | null = null;
  /** A request whose outcome is unknown (network failure, 5xx); re-sent as is, same key. */
  private unconfirmed: Request | null = null;
  private keepalive = false;
  private reveal = false;
  private disposedFlag = false;

  private readonly listeners = new Set<() => void>();
  private readonly savedListeners = new Set<SavedListener>();
  private snapshot: AutosaveSnapshot;

  /** For tests and diagnostics: how many requests were in flight at once, at most. */
  maxConcurrent = 0;
  private concurrent = 0;

  constructor(options: AutosaveOptions) {
    this.taskId = options.task.id;
    this.base = options.task;
    this.viewerZone = options.viewerZone;
    this.draft = draftFromTask(options.task, options.viewerZone);
    this.send = options.send;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.isOnline =
      options.isOnline ?? (() => (typeof navigator === "undefined" ? true : navigator.onLine));
    this.newKey = options.newKey ?? newIdempotencyKey;
    this.snapshot = this.build();
  }

  // --- Reading ----------------------------------------------------------------------------------

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): AutosaveSnapshot => this.snapshot;

  get listenerCount(): number {
    return this.listeners.size;
  }

  get disposed(): boolean {
    return this.disposedFlag;
  }

  /** Called after every confirmed save (lists refresh, the panel looks for a next occurrence). */
  onSaved(listener: SavedListener): () => void {
    this.savedListeners.add(listener);
    return () => {
      this.savedListeners.delete(listener);
    };
  }

  /** True while anything the user typed or chose is not confirmed by the server. */
  hasUnsaved(): boolean {
    return (
      this.dirty.size > 0 || this.unconfirmed !== null || this.sending !== null || this.conflict
    );
  }

  // --- Editing ----------------------------------------------------------------------------------

  /** Change what the fields show and queue the affected groups. */
  edit(patch: Partial<TaskDraft>, mode: EditMode): void {
    if (this.disposedFlag) return;
    const fields = Object.keys(patch) as (keyof TaskDraft)[];
    if (fields.length === 0) return;
    this.draft = { ...this.draft, ...patch };
    for (const field of fields) this.touched.add(field);
    for (const group of new Set(fields.map(groupOf))) {
      this.dirty.add(group);
      this.lastMode.set(group, mode);
      // A new value deserves a new verdict from the server.
      delete this.errors[group];
    }
    if (mode === "debounce") {
      this.restartTimer();
      this.emit();
    } else if (mode === "now") {
      this.clearTimer();
      this.emit();
      void this.kick();
    } else {
      this.emit();
    }
  }

  /** The field that has focus keeps its text even when a save of it returns a normalised value. */
  setFocus(field: keyof TaskDraft | null): void {
    const left = this.focused;
    this.focused = field;
    if (left && left !== field && !this.touched.has(left) && !this.isSending(groupOf(left))) {
      this.adoptFields([left]);
      this.emit();
    }
  }

  /**
   * Send everything now (blur, close, switching task, page hide) and wait for the queue to drain.
   * Resolves `true` when every edit is confirmed; otherwise the reasons are in the snapshot.
   */
  async flush(options: { keepalive?: boolean } = {}): Promise<boolean> {
    if (this.disposedFlag) return !this.hasUnsaved();
    this.clearTimer();
    if (options.keepalive) this.keepalive = true;
    this.reveal = true;
    this.failure = null;
    while (this.loop) await this.loop;
    do {
      await this.kick();
    } while (this.loop);
    this.keepalive = false;
    this.reveal = false;
    const errors: Partial<Record<FieldGroup, FieldError>> = {};
    for (const [group, error] of Object.entries(this.errors) as [FieldGroup, FieldError][]) {
      errors[group] = { ...error, shown: true };
    }
    this.errors = errors;
    this.emit();
    return !this.hasUnsaved();
  }

  /** Try again after a failure (the Retry button, the `online` event). */
  retry(): Promise<boolean> {
    return this.flush();
  }

  /**
   * A newer version arrived from outside the panel (a list action on the same task). It is adopted
   * only when nothing local is pending; otherwise the next save meets the server's revision check.
   */
  adopt(task: Task): boolean {
    if (this.disposedFlag || task.id !== this.taskId || task.revision <= this.base.revision) {
      return false;
    }
    if (this.hasUnsaved() || this.loop) return false;
    this.base = task;
    this.draft = draftFromTask(task, this.viewerZone);
    this.emit();
    return true;
  }

  /**
   * Resolve a conflict with the server's latest version: the fields show it, and the local values
   * that were not saved are set aside in `stash` (offered for reapplying, never sent by themselves).
   */
  loadLatest(latest: Task): void {
    if (this.disposedFlag) return;
    // Only what the user changed, and only where it differs from the latest version.
    const fields = new Set([...this.touched, ...(this.unconfirmed?.touched ?? [])]);
    const latestDraft = draftFromTask(latest, this.viewerZone);
    const stash: Partial<TaskDraft> = {};
    for (const field of fields) {
      if (this.draft[field] !== latestDraft[field]) {
        (stash as Record<string, string>)[field] = this.draft[field];
      }
    }
    this.clearTimer();
    this.dirty.clear();
    this.touched.clear();
    this.errors = {};
    this.unconfirmed = null;
    this.failure = null;
    this.offline = false;
    this.conflict = false;
    this.base = latest;
    this.draft = draftFromTask(latest, this.viewerZone);
    this.stash = Object.keys(stash).length > 0 ? stash : null;
    this.emit();
  }

  /** Put the set-aside values back as new edits (saved against the latest revision). */
  reapply(): void {
    const stash = this.stash;
    this.stash = null;
    if (stash) this.edit(stash, "now");
    else this.emit();
  }

  /**
   * Settle one set-aside field (SYNC-11a-2): `text` is written as a new edit against the latest
   * revision (a normal revision-checked save, so a newer change still conflicts instead of being
   * overwritten); `null` drops the local value and keeps the latest one. The other fields stay set aside.
   */
  resolveStashField(field: keyof TaskDraft, text: string | null): void {
    const stash = this.stash;
    if (!stash || !(field in stash)) return;
    const rest = { ...stash };
    delete rest[field];
    this.stash = Object.keys(rest).length > 0 ? rest : null;
    if (text === null) this.emit();
    else this.edit({ [field]: text } as Partial<TaskDraft>, "now");
  }

  dismissStash(): void {
    this.stash = null;
    this.emit();
  }

  /** Throw away every unsaved edit (an explicit "Discard changes"). */
  discard(): void {
    this.clearTimer();
    this.dirty.clear();
    this.touched.clear();
    this.errors = {};
    this.unconfirmed = null;
    this.failure = null;
    this.offline = false;
    this.conflict = false;
    this.stash = null;
    this.draft = draftFromTask(this.base, this.viewerZone);
    this.emit();
  }

  dispose(): void {
    this.clearTimer();
    this.disposedFlag = true;
    this.listeners.clear();
    this.savedListeners.clear();
  }

  // --- Sending ----------------------------------------------------------------------------------

  private kick(): Promise<void> {
    this.wanted = true;
    if (!this.loop) {
      this.loop = this.run().finally(() => {
        this.loop = null;
        this.emit();
        if (this.wanted && !this.disposedFlag) void this.kick();
      });
    }
    return this.loop;
  }


  private nextRequest(): Request | null {
    if (this.unconfirmed) return this.unconfirmed;
    for (const group of this.dirty) {
      if (this.errors[group]) continue; // rejected; waits for a new value
      this.dirty.delete(group);
      const touched = GROUP_FIELDS[group].filter((field) => this.touched.has(field));
      for (const field of touched) this.touched.delete(field);
      const baseDraft = draftFromTask(this.base, this.viewerZone);
      const overlay = { ...baseDraft, ...pick(this.draft, [group]) };
      const fields = changesFromDraft(baseDraft, overlay, this.viewerZone);
      if (Object.keys(fields).length === 0) {
        continue; // typed back to what the server has
      }
      return { groups: [group], touched, fields, base: this.base, key: this.newKey() };
    }
    return null;
  }

  private async run(): Promise<void> {
    for (;;) {
      this.wanted = false;
      if (this.disposedFlag || this.conflict) break;
      const pending = this.unconfirmed !== null || [...this.dirty].some((g) => !this.errors[g]);
      if (!pending) break;
      if (!this.isOnline()) {
        this.offline = true;
        break;
      }
      const request = this.nextRequest();
      if (!request) break;
      this.sending = request;
      this.offline = false;
      this.emit();
      this.concurrent += 1;
      this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
      try {
        const saved = await this.send(request.base, request.fields, {
          idempotencyKey: request.key,
          ...(this.keepalive ? { keepalive: true } : {}),
        });
        this.concurrent -= 1;
        this.sending = null;
        this.unconfirmed = null;
        this.failure = null;
        this.accept(saved);
      } catch (err) {
        this.concurrent -= 1;
        this.sending = null;
        if (isRevisionConflict(err)) {
          this.unconfirmed = null;
          this.requeue(request);
          this.conflict = true;
          break;
        }
        if (isRejection(err)) {
          this.unconfirmed = null;
          this.requeue(request);
          for (const group of request.groups) {
            // Only if the user has not typed a newer value meanwhile (that one gets its own verdict).
            if (!this.changedSince(group, request)) {
              const quiet = this.lastMode.get(group) === "debounce" && !this.reveal;
              this.errors[group] = { message: messageOf(err), shown: !quiet };
            }
          }
          continue;
        }
        // Outcome unknown: keep the exact request and stop until something asks to retry.
        this.unconfirmed = request;
        this.offline = !(err instanceof ApiError);
        this.failure = messageOf(err);
        break;
      }
    }
  }

  private requeue(request: Request) {
    for (const group of request.groups) this.dirty.add(group);
    for (const field of request.touched) this.touched.add(field);
  }

  private changedSince(group: FieldGroup, request: Request): boolean {
    const baseDraft = draftFromTask(request.base, this.viewerZone);
    const sent = { ...baseDraft, ...pick(this.draft, [group]) };
    const fields = changesFromDraft(baseDraft, sent, this.viewerZone);
    return JSON.stringify(fields) !== JSON.stringify(request.fields);
  }

  private isSending(group: FieldGroup): boolean {
    return (
      (this.sending?.groups.includes(group) ?? false) ||
      (this.unconfirmed?.groups.includes(group) ?? false)
    );
  }

  /** The server confirmed a request: take its version, and its values for untouched fields. */
  private accept(saved: Task) {
    const previous = this.base;
    this.base = saved;
    const settled = GROUPS.filter((group) => !this.isSending(group)).flatMap((group) =>
      GROUP_FIELDS[group].filter((field) => !this.touched.has(field) && field !== this.focused),
    );
    this.adoptFields(settled);
    this.emit();
    for (const listener of this.savedListeners) listener(saved, previous);
  }

  private adoptFields(fields: (keyof TaskDraft)[]) {
    if (fields.length === 0) return;
    const fresh = draftFromTask(this.base, this.viewerZone);
    const next = { ...this.draft };
    for (const field of fields) (next as Record<string, string>)[field] = fresh[field];
    this.draft = next;
  }

  private restartTimer() {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.kick();
    }, this.debounceMs);
  }

  private clearTimer() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // --- Snapshot ---------------------------------------------------------------------------------

  private state(): SaveState {
    if (this.conflict) return "conflict";
    if (this.sending) return "saving";
    if (this.unconfirmed) return this.offline ? "offline" : "failed";
    const waiting = [...this.dirty].filter((group) => !this.errors[group]);
    if (waiting.length > 0 && (this.offline || !this.isOnline())) return "offline";
    if (Object.values(this.errors).some((error) => error?.shown)) return "invalid";
    if (this.timer !== null || this.loop !== null) {
      return waiting.length > 0 || this.loop !== null ? "saving" : "unsaved";
    }
    if (this.dirty.size > 0) return "unsaved";
    return "saved";
  }

  private build(): AutosaveSnapshot {
    const unsaved = GROUPS.filter((group) => this.dirty.has(group) || this.isSending(group));
    return {
      task: this.base,
      draft: this.draft,
      state: this.state(),
      unsaved,
      errors: { ...this.errors },
      failure: this.failure,
      conflict: this.conflict,
      stash: this.stash,
    };
  }

  private emit() {
    if (this.disposedFlag) return;
    this.snapshot = this.build();
    for (const listener of this.listeners) listener();
  }
}

// --- Registry ------------------------------------------------------------------------------------

/**
 * Sessions outlive the panel while they hold unsaved edits: closing the panel (or navigating away)
 * flushes, and if that fails the session stays here, so reopening the task shows the unsaved values
 * and their state instead of silently losing them. A clean session is dropped when released.
 */
const sessions = new Map<string, TaskAutosave>();
let listening = false;

function flushAll(keepalive: boolean) {
  for (const session of sessions.values()) {
    if (session.hasUnsaved()) void session.flush({ keepalive });
  }
}

function listenOnce() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  // Leaving or hiding the page is a flush point; keepalive lets the request outlive the page.
  window.addEventListener("pagehide", () => flushAll(true));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushAll(true);
  });
  window.addEventListener("online", () => flushAll(false));
}

export function openSession(options: AutosaveOptions): TaskAutosave {
  listenOnce();
  const existing = sessions.get(options.task.id);
  if (existing && !existing.disposed) {
    existing.adopt(options.task);
    return existing;
  }
  const session = new TaskAutosave(options);
  sessions.set(session.taskId, session);
  return session;
}

/** The panel showing `session` went away. Clean sessions are dropped; others flush and stay. */
export function releaseSession(session: TaskAutosave): void {
  const drop = () => {
    if (session.listenerCount === 0 && !session.hasUnsaved()) {
      session.dispose();
      if (sessions.get(session.taskId) === session) sessions.delete(session.taskId);
    }
  };
  // Deferred, so an immediate remount (React StrictMode, a quick reopen) keeps the same session.
  queueMicrotask(() => {
    if (session.listenerCount > 0 || session.disposed) return;
    if (session.hasUnsaved()) void session.flush().then(drop);
    else drop();
  });
}

/** The task was deleted: forget its session (undo restores the server's last confirmed version). */
export function forgetSession(taskId: string): void {
  const session = sessions.get(taskId);
  session?.dispose();
  sessions.delete(taskId);
}

/** Test helper: drop every session. */
export function resetSessions(): void {
  for (const session of sessions.values()) session.dispose();
  sessions.clear();
}
