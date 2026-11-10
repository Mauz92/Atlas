import {
  SyncActionSink,
  SyncEngine,
  SyncReminderSource,
  type EngineObserver,
  type Halt,
  type Logger,
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
