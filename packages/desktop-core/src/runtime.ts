import {
  SyncActionSink,
  SyncEngine,
  SyncReminderSource,
  type EngineObserver,
  type Halt,
  type Json,
  type Logger,
  type Problem,
  type ResolutionRecord,
  type SyncStatus,
  type LogFields,
} from "../../sync-core/src/index.ts";
import { Scheduler, type NotifySettings } from "../../reminder-core/src/index.ts";
import { LiveConnection } from "./live.ts";
import { NotesFolderSync, type NotesSyncReport } from "./notes/sync.ts";
import type { DbOp, PlatformPort, SessionInfo, SignInResult } from "./ports.ts";
import { DesktopNotificationPort, RowSchedulerStore, schedulerClock } from "./reminderAdapters.ts";
import { DEFAULT_DESKTOP_SETTINGS, loadSettings, saveSettings, type DesktopSettings } from "./settings.ts";
import { SqliteLocalStore } from "./sqliteStore.ts";
import { checkBaseUrl } from "./urlRules.ts";
import { createPortTransport } from "./transport.ts";

export type RuntimePhase = "starting" | "signed_out" | "running" | "update_required" | "failed";

export interface RuntimeSnapshot {
  phase: RuntimePhase;
  /** Why the app is in `signed_out` / `update_required` / `failed` (a state word, never content). */
  reason: string | null;
  session: SessionInfo | null;
  sync: SyncStatus | null;
  notes: NotesSyncReport | null;
  settings: DesktopSettings;
  live: boolean;
  /** Wall-clock time of the last hint from the live connection (SYNC-11b); display only. */
  lastHintAt: number | null;
  notificationPermission: string;
}

export interface RuntimeOptions {
  /** Engine tick period. */
  tickMs?: number;
  /** Scheduler tick period (reminders fire within about this much of their instant; M8-04c asks for 60 s). */
  schedulerTickMs?: number;
  /** Full folder scan period (the watcher is a hint; this is the safety net). */
  fullScanMs?: number;
  logger?: Logger;
  /** Engine option overrides (tests use short intervals). */
  engineOptions?: ConstructorParameters<typeof SyncEngine>[0]["options"];
  /** Waits for `sleep` use the host timers; tests can run with a fast live poll. */
  liveWaitSeconds?: number;
  debounceMs?: number;
}

/** What an undo came back with: the server's answer, or `queued` when this device is offline (it is sent later). */
export type UndoAnswer = { status: number; body: unknown } | { queued: true };

const UNDO_WAIT_MS = 15_000;

const NOOP_LOGGER: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * The desktop client runtime (SYNC-09d, ADR-0069): the sync-core engine over the SQLite store, the
 * reminder scheduler over the platform notifier, the notes-folder engine, the live connection, the
 * device settings and the signed-out / update-required states. It runs inside the shell's webview
 * (hidden while the window is in the tray, which is why the webview must stay alive: close-to-tray
 * only hides the window) and depends on nothing but the {@link PlatformPort}.
 */
export class DesktopRuntime {
  private readonly listeners = new Set<(s: RuntimeSnapshot) => void>();
  private phase: RuntimePhase = "starting";
  private reason: string | null = null;
  private session: SessionInfo | null = null;
  private settings: DesktopSettings = { ...DEFAULT_DESKTOP_SETTINGS };
  private permission = "default";
  private engine: SyncEngine | null = null;
  private scheduler: Scheduler | null = null;
  private notes: NotesFolderSync | null = null;
  private live: LiveConnection | null = null;
  private cancels: Array<() => void> = [];
  private lastWall: number | null = null;
  private lastMono = 0;
  private ticking = false;
  private opened = false;
  private lastHintAt: number | null = null;
  private readonly undoWaiters = new Map<string, (answer: UndoAnswer) => void>();

  constructor(
    private readonly p: PlatformPort,
    private readonly options: RuntimeOptions = {},
  ) {}

  // --- observation ---------------------------------------------------------------------------

  subscribe(listener: (s: RuntimeSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async snapshot(): Promise<RuntimeSnapshot> {
    return {
      phase: this.phase,
      reason: this.reason,
      session: this.session,
      sync: this.engine ? await this.engine.getStatus() : null,
      notes: this.notes ? this.notes.status() : null,
      settings: { ...this.settings },
      live: this.live?.active ?? false,
      lastHintAt: this.lastHintAt,
      notificationPermission: this.permission,
    };
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    void this.snapshot().then((s) => this.listeners.forEach((l) => l(s)));
  }

  /** Test and shell access to the engine (the web UI never gets it). */
  get syncEngine(): SyncEngine | null {
    return this.engine;
  }
  get folderSync(): NotesFolderSync | null {
    return this.notes;
  }
  get reminderScheduler(): Scheduler | null {
    return this.scheduler;
  }

  // --- life cycle ----------------------------------------------------------------------------

  /** Open the database, read the session and, when signed in, start everything. */
  async start(): Promise<RuntimeSnapshot> {
    try {
      if (!this.opened) {
        await this.p.db.open();
        this.opened = true;
      }
      this.settings = await loadSettings(this.p.db);
      await this.p.tray.setCloseToTray(this.settings.closeToTray);
      this.permission = await this.p.notifier.permission();
      this.session = await this.p.session.info();
      if (!this.session.signedIn) {
        this.phase = "signed_out";
        this.reason = this.session.keystoreError ? "keystore_unavailable" : null;
        this.emit();
        return this.snapshot();
      }
      await this.startServices();
    } catch (e) {
      this.phase = "failed";
      this.reason = e instanceof Error ? e.message.slice(0, 200) : "start failed";
      this.emit();
    }
    return this.snapshot();
  }

  async signIn(input: { baseUrl: string; email: string; password: string; deviceName: string }): Promise<SignInResult> {
    const checked = checkBaseUrl(input.baseUrl);
    if (!checked.ok) return { ok: false, failure: checked.failure, detail: checked.detail };
    const result = await this.p.session.signIn({ ...input, baseUrl: checked.baseUrl });
    if (!result.ok) return result;
    // a different account's data must never be mixed into this database
    await this.resetLocalDataIfAccountChanged(checked.baseUrl, input.email);
    this.session = await this.p.session.info();
    await this.startServices();
    return result;
  }

  /**
   * Signing in again as the SAME account on the SAME server keeps the local database (cursor, queued
   * edits, notes index): nothing is lost and nothing is re-downloaded. A different account or server
   * starts from an empty database (another account's queued edits must never be sent to this one; the
   * sign-out screen warns when edits are still queued). Files in the notes folder are never deleted by this.
   */
  private async resetLocalDataIfAccountChanged(baseUrl: string, email: string): Promise<void> {
    const account = JSON.stringify(`${baseUrl}|${email.trim().toLowerCase()}`);
    const previous = await this.p.db.get("settings", "account");
    const ops: DbOp[] = [];
    if (previous !== null && previous !== account) {
      for (const table of ["entities", "queue", "meta", "resolutions", "problems", "drafts", "scheduler", "notes_index"] as const) ops.push({ op: "clear", table });
    }
    ops.push({ op: "put", table: "settings", key: "account", value: account });
    await this.p.db.commit(ops);
  }

  async signOut(): Promise<void> {
    await this.stopServices();
    await this.p.session.signOut();
    this.session = await this.p.session.info();
    this.phase = "signed_out";
    this.reason = "signed_out";
    this.emit();
  }

  async stop(): Promise<void> {
    await this.stopServices();
  }

  private async startServices(): Promise<void> {
    await this.stopServices();
    const p = this.p;
    const logger = this.options.logger ?? NOOP_LOGGER;
    const observer: EngineObserver = {
      halted: (halt) => void this.onHalt(halt),
      pullCompleted: () => {
        void this.reconcileScheduler();
        this.notes?.hint();
        this.emit();
      },
      ack: () => this.emit(),
      undone: (op, response) => this.settleUndo(op.entityId, response),
      undoRefused: (op, response) => this.settleUndo(op.entityId, response),
    };
    const engine = new SyncEngine({
      store: new SqliteLocalStore(p.db),
      transport: createPortTransport(p.http),
      clock: { monotonic: () => p.timers.monotonic(), wallTime: () => p.timers.wallTime() },
      ids: { uuid: () => p.crypto.uuid() },
      random: { next: () => p.crypto.random() },
      logger,
      observer,
      options: {
        reminders: true,
        deviceId: this.session?.device?.id ?? null,
        ...this.options.engineOptions,
      },
    });
    this.engine = engine;

    const scheduler = new Scheduler({
      clock: schedulerClock(p.timers),
      port: new DesktopNotificationPort(p.notifier),
      store: new RowSchedulerStore(p.db),
      source: new SyncReminderSource(engine),
      actions: new SyncActionSink(engine),
      ids: { uuid: () => p.crypto.uuid() },
      logger: {
        info: (e, f) => logger.info(e, (f ?? {}) as LogFields),
        warn: (e, f) => logger.warn(e, (f ?? {}) as LogFields),
      },
    });
    this.scheduler = scheduler;
    await this.applySchedulerSettings();

    const notes = new NotesFolderSync({
      engine,
      folder: p.folder,
      db: p.db,
      crypto: p.crypto,
      timers: p.timers,
      onEngineChanged: () => void engine.tick(),
      ...(this.options.debounceMs !== undefined ? { debounceMs: this.options.debounceMs } : {}),
    });
    this.notes = notes;

    const sleep = (ms: number) => new Promise<void>((resolve) => this.cancels.push(p.timers.setTimeout(resolve, ms)));
    this.live = new LiveConnection({
      http: p.http,
      timers: Object.assign(Object.create(p.timers) as typeof p.timers, { sleep }),
      random: { next: () => p.crypto.random() },
      cursor: async () => (await engine.getStatus()).cursor,
      onHint: () => {
        this.lastHintAt = p.timers.wallTime();
        this.emit();
        engine.requestPull();
        void engine.tick();
      },
      onUnauthorized: () => void this.noteUnauthorized(),
      onUpdateRequired: () => void this.noteUpdateRequired(),
      ...(this.options.liveWaitSeconds !== undefined ? { waitSeconds: this.options.liveWaitSeconds } : {}),
    });

    this.phase = "running";
    this.reason = null;
    this.lastWall = p.timers.wallTime();
    this.lastMono = p.timers.monotonic();

    this.cancels.push(p.timers.setInterval(() => void this.engineTick(), this.options.tickMs ?? 1_000));
    this.cancels.push(p.timers.setInterval(() => void this.schedulerTick(), this.options.schedulerTickMs ?? 30_000));
    this.cancels.push(p.timers.setInterval(() => void notes.reconcile(true), this.options.fullScanMs ?? 5 * 60_000));
    this.cancels.push(
      p.lifecycle.onWake(() => {
        engine.retryNow();
        engine.requestPull();
        void notes.reconcile(true);
        void this.schedulerTick();
      }),
    );
    this.cancels.push(
      p.tray.onMenu((item) => {
        if (item === "open") void p.lifecycle.showWindow();
        else {
          engine.retryNow();
          engine.requestPull();
        }
      }),
    );
    notes.start();
    this.live.start();
    await scheduler.onBoot();
    await notes.reconcile(true); // start: hash every file (a same-size edit with an unchanged mtime is found here)
    void engine.tick();
    this.emit();
  }

  private async stopServices(): Promise<void> {
    this.live?.stop();
    this.notes?.stop();
    for (const cancel of this.cancels.splice(0)) cancel();
    this.engine?.dispose();
    this.engine = null;
    this.scheduler = null;
    this.notes = null;
    this.live = null;
  }

  // --- ticks ----------------------------------------------------------------------------------

  private async engineTick(): Promise<void> {
    const engine = this.engine;
    if (!engine || this.ticking) return;
    this.ticking = true;
    try {
      await engine.tick();
    } finally {
      this.ticking = false;
    }
  }

  private async schedulerTick(): Promise<void> {
    const scheduler = this.scheduler;
    if (!scheduler) return;
    // A wall clock that moved differently from the monotonic one (sleep/resume, a manual change) re-arms everything.
    const wall = this.p.timers.wallTime();
    const mono = this.p.timers.monotonic();
    const jumped = this.lastWall !== null && Math.abs(wall - this.lastWall - (mono - this.lastMono)) > 60_000;
    this.lastWall = wall;
    this.lastMono = mono;
    try {
      if (jumped) await scheduler.onClockChange();
      else await scheduler.tick();
    } catch (e) {
      this.options.logger?.error("scheduler_tick_failed", { message: e instanceof Error ? e.message.slice(0, 120) : "unknown" });
    }
  }

  private async reconcileScheduler(): Promise<void> {
    try {
      await this.scheduler?.tick();
    } catch {
      /* the next tick retries */
    }
  }

  // --- what the web UI may ask of the engine (SYNC-11c) ---------------------------------------
  //
  // The page never gets the engine, the store or a token: these are the few verbs the conflict, notice
  // and restore screens need, each a thin call over `SyncEngine` (the rules stay in sync-core).

  private requireEngine(): SyncEngine {
    if (!this.engine) throw new Error("not signed in");
    return this.engine;
  }

  /** "Changed on another device" entries held locally, newest first. */
  async uiResolutions(): Promise<ResolutionRecord[]> {
    const all = await this.requireEngine().resolutions();
    return [...all].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  }

  async uiProblems(): Promise<Problem[]> {
    return this.requireEngine().problems();
  }

  async uiDismissProblem(id: string): Promise<void> {
    await this.requireEngine().dismissProblem(id);
    this.emit();
  }

  /**
   * Undo an automatic resolution through the engine's durable queue (one Idempotency-Key for the whole
   * life of the request). Resolves with the server's answer, or `queued` when it did not come within
   * 15 s (offline): the undo is then still queued and is sent when the connection returns.
   */
  async uiUndo(resolutionId: string): Promise<UndoAnswer> {
    const engine = this.requireEngine();
    const answer = new Promise<UndoAnswer>((resolve) => this.undoWaiters.set(resolutionId, resolve));
    await engine.undoResolution(resolutionId);
    void engine.tick();
    const timeout = new Promise<UndoAnswer>((resolve) => {
      this.cancels.push(this.p.timers.setTimeout(() => resolve({ queued: true }), UNDO_WAIT_MS));
    });
    const result = await Promise.race([answer, timeout]);
    this.undoWaiters.delete(resolutionId);
    this.emit();
    return result;
  }

  private settleUndo(resolutionId: string, response: { status: number; body?: unknown }): void {
    this.undoWaiters.get(resolutionId)?.({ status: response.status, body: response.body ?? null });
    this.emit();
  }

  /** The person chose "Re-upload my local data" (D12). */
  async uiConfirmRestore(): Promise<void> {
    await this.requireEngine().confirmRestore();
    this.emit();
  }

  /** The person chose "Discard local changes and re-download" (asked twice by the screen). */
  async uiDiscardLocal(): Promise<void> {
    await this.requireEngine().discardLocalAndRedownload();
    this.emit();
  }

  /**
   * Settle a text conflict of a task or project field with the person's chosen text: a normal queued
   * edit against the revision this device now holds (so a newer change still conflicts), then the
   * problem is dismissed. Nothing is dismissed if the edit could not be queued.
   */
  async uiResolveText(problemId: string, field: string, text: string): Promise<void> {
    const engine = this.requireEngine();
    const problem = (await engine.problems()).find((p) => p.id === problemId);
    if (!problem || problem.entityType === "resolution" || problem.entityType === "note" || problem.entityType === "reminder") {
      throw new Error("this problem has no text field to settle");
    }
    // The edit is based on the revision this device holds. After a conflict that is usually still the old
    // one, so read the newer revision first (bounded: if it does not arrive, the edit may conflict once
    // more, and then both versions are still kept).
    const wanted = Math.max(0, ...problem.conflicts.map((c) => c.serverRevision ?? 0));
    engine.requestPull();
    for (let waited = 0; waited < 10_000 && wanted > 0; waited += 500) {
      if (((await engine.view(problem.entityId))?.serverRevision ?? 0) >= wanted) break;
      void engine.tick();
      await new Promise<void>((resolve) => this.cancels.push(this.p.timers.setTimeout(resolve, 500)));
    }
    await engine.updateEntity(problem.entityType, problem.entityId, { [field]: text } as Record<string, Json>);
    await engine.dismissProblem(problemId);
    void engine.tick();
    this.emit();
  }

  /** The person updated the app (or the server): look again. */
  async uiResumeAfterUpdate(): Promise<void> {
    await this.requireEngine().resumeAfterUpdate();
    this.emit();
  }

  // --- halts ----------------------------------------------------------------------------------

  private async onHalt(halt: Halt): Promise<void> {
    if (halt.kind === "signed_out") await this.noteUnauthorized(halt.code);
    else if (halt.kind === "update_required") await this.noteUpdateRequired();
    else this.emit();
  }

  /** The server said 401 (revoked or expired token): stop, forget the token, show the sign-in page. */
  async noteUnauthorized(code: string | null = null): Promise<void> {
    if (this.phase === "signed_out") return;
    await this.stopServices();
    await this.p.session.clear();
    this.session = await this.p.session.info();
    this.phase = "signed_out";
    this.reason = code ?? "token_revoked";
    this.emit();
    await this.p.lifecycle.gotoSignIn("signed_out");
  }

  /** The server speaks a newer protocol (426): syncing stops, the token stays, the user must update the app. */
  async noteUpdateRequired(): Promise<void> {
    if (this.phase === "update_required") return;
    await this.stopServices();
    this.phase = "update_required";
    this.reason = "update_required";
    this.emit();
    await this.p.lifecycle.gotoSignIn("update_required");
  }

  // --- user actions ---------------------------------------------------------------------------

  async syncNow(): Promise<void> {
    this.engine?.retryNow();
    this.engine?.requestPull();
    await this.notes?.reconcile(true);
    await this.engine?.tick();
  }

  async chooseNotesFolder(): Promise<string | null> {
    const root = await this.p.folder.choose();
    if (root !== null) await this.notes?.reconcile(true);
    this.emit();
    return root;
  }

  async updateSettings(patch: Partial<DesktopSettings>): Promise<DesktopSettings> {
    this.settings = { ...this.settings, ...patch };
    await saveSettings(this.p.db, this.settings);
    if (patch.closeToTray !== undefined) await this.p.tray.setCloseToTray(this.settings.closeToTray);
    await this.applySchedulerSettings();
    this.emit();
    return { ...this.settings };
  }

  private async applySchedulerSettings(): Promise<void> {
    const patch: Partial<NotifySettings> = { enabled: this.settings.remindersEnabled, contentMode: this.settings.contentMode };
    await this.scheduler?.updateSettings(patch);
  }

  async requestNotificationPermission(): Promise<string> {
    this.permission = await this.p.notifier.requestPermission();
    this.emit();
    return this.permission;
  }

  async testNotification(): Promise<{ shownNow: boolean; scheduledAt: number | null }> {
    if (this.scheduler) return this.scheduler.testNotification();
    await this.p.notifier.show({ title: "Atlas", body: "This is a test notification.", tag: null });
    return { shownNow: true, scheduledAt: null };
  }

  /** The first-run answers (called by the sign-in page): folder was chosen elsewhere; this records autostart. */
  async answerAutostart(enable: boolean): Promise<void> {
    await this.p.autostart.setEnabled(enable);
    await this.updateSettings({ autostartAsked: true });
  }
}
