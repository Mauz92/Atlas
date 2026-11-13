import { createHash } from "node:crypto";
import {
  seededRandom,
  sequenceIds,
} from "../../../sync-core/src/testing/index.ts";
import type {
  AlarmPort,
  AlarmSpec,
  AlarmStatus,
  AutostartPort,
  CryptoPort,
  FolderEntry,
  HttpPort,
  HttpPortRequest,
  HttpPortResponse,
  LifecyclePort,
  NotesFolderPort,
  NotifierPort,
  NotifyPermission,
  PlatformPort,
  RenameResult,
  SessionInfo,
  SessionPort,
  SignInResult,
  TimerPort,
  TrashResult,
  TrayPort,
  WriteResult,
  DeviceRecord,
} from "../ports.ts";
import { FakeRowDb } from "./fakeDb.ts";

export const sha256Hex = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** Virtual time: nothing runs until a test advances it. */
export class FakeTimers implements TimerPort {
  mono = 0;
  wall = 1_800_000_000_000;
  private seq = 0;
  private timers = new Map<
    number,
    { at: number; fn: () => void; every: number | null }
  >();
  offsetMinutes = 0;

  monotonic(): number {
    return this.mono;
  }
  wallTime(): number {
    return this.wall;
  }
  utcOffsetMinutes(): number {
    return this.offsetMinutes;
  }
  setTimeout(fn: () => void, ms: number): () => void {
    const id = ++this.seq;
    this.timers.set(id, { at: this.mono + ms, fn, every: null });
    return () => void this.timers.delete(id);
  }
  setInterval(fn: () => void, ms: number): () => void {
    const id = ++this.seq;
    this.timers.set(id, { at: this.mono + ms, fn, every: ms });
    return () => void this.timers.delete(id);
  }
  /** Advance both clocks, running due timers in order; lets promise continuations settle between them. */
  async advance(
    ms: number,
    { wallOnly = false }: { wallOnly?: boolean } = {},
  ): Promise<void> {
    if (wallOnly) {
      this.wall += ms;
      return;
    }
    const end = this.mono + ms;
    for (;;) {
      let next:
        [number, { at: number; fn: () => void; every: number | null }] | null =
        null;
      for (const entry of this.timers)
        if (entry[1].at <= end && (!next || entry[1].at < next[1].at))
          next = entry;
      if (!next) break;
      const [id, t] = next;
      this.wall += t.at - this.mono;
      this.mono = t.at;
      if (t.every !== null) t.at += t.every;
      else this.timers.delete(id);
      t.fn();
      await settle();
    }
    this.wall += end - this.mono;
    this.mono = end;
    await settle();
  }
}

export async function settle(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i++)
    await new Promise<void>((r) => setImmediate(r));
}

export class FakeCrypto implements CryptoPort {
  private ids;
  private rng;
  /** Devices of one test need different seeds: equal ids would collide on the shared server. */
  constructor(seed = 7) {
    this.ids = sequenceIds(seed);
    this.rng = seededRandom(seed + 4);
  }
  uuid(): string {
    return this.ids.uuid();
  }
  random(): number {
    return this.rng.next();
  }
  async sha256(text: string): Promise<string> {
    return sha256Hex(text);
  }
}

export class FakeHttp implements HttpPort {
  requests: HttpPortRequest[] = [];
  handler: (req: HttpPortRequest) => Promise<HttpPortResponse> = async () => ({
    status: 200,
    headers: {},
    body: "{}",
  });
  /** true: every request rejects (no connection). */
  offline = false;
  async request(req: HttpPortRequest): Promise<HttpPortResponse> {
    this.requests.push(req);
    if (this.offline) throw new Error("network down");
    if (!req.path.startsWith("/api/"))
      throw new Error("path must start with /api/");
    return this.handler(req);
  }
}

export class FakeSession implements SessionPort {
  token: string | null = null;
  baseUrl: string | null = null;
  device: DeviceRecord | null = null;
  keystoreError: string | null = null;
  signInResult: SignInResult | null = null;
  signedOutOnServer = 0;
  async signIn(input: {
    baseUrl: string;
    email: string;
    password: string;
    deviceName: string;
  }): Promise<SignInResult> {
    if (this.keystoreError)
      return {
        ok: false,
        failure: "keystore_unavailable",
        detail: this.keystoreError,
      };
    const result: SignInResult = this.signInResult ?? {
      ok: true,
      device: { id: "dev-1", name: input.deviceName, platform: "linux" },
      baseUrl: input.baseUrl,
    };
    if (result.ok) {
      this.token = "secret-token-never-returned";
      this.baseUrl = input.baseUrl;
      this.device = result.device;
    }
    return result;
  }
  async info(): Promise<SessionInfo> {
    return {
      signedIn: this.token !== null,
      baseUrl: this.baseUrl,
      device: this.device,
      keystoreError: this.keystoreError,
    };
  }
  async clear(): Promise<void> {
    this.token = null;
    this.baseUrl = null;
    this.device = null;
  }
  async signOut(): Promise<void> {
    this.signedOutOnServer++;
    await this.clear();
  }
}

interface FakeFile {
  content: string;
  mtimeMs: number;
}

/** An in-memory notes folder with the host's compare-and-swap rules, trash and change hints. */
export class FakeFolder implements NotesFolderPort {
  files = new Map<string, FakeFile>();
  trashed: Array<{ path: string; content: string }> = [];
  rootPath: string | null = "/fake/Atlas Notes";
  missing = false;
  extra: FolderEntry[] = []; // files the scan reports but the engine must skip (too_large, invalid_utf8, ...)
  private listeners = new Set<() => void>();
  private clock = 1;
  scans: Array<{ full: boolean }> = [];
  /** Hook run after a write has been checked but before it is applied (a race: the user edits at that moment). */
  beforeApply: ((path: string) => void) | null = null;

  /** What a user or another program does to the folder. */
  put(path: string, content: string): void {
    this.files.set(path, { content, mtimeMs: this.clock++ });
    this.emit();
  }
  remove(path: string): void {
    this.files.delete(path);
    this.emit();
  }
  move(from: string, to: string): void {
    const f = this.files.get(from);
    if (!f) return;
    this.files.delete(from);
    this.files.set(to, f);
    this.emit();
  }
  get(path: string): string | undefined {
    return this.files.get(path)?.content;
  }
  emit(): void {
    for (const l of this.listeners) l();
  }
  async root(): Promise<string | null> {
    return this.rootPath;
  }
  async choose(): Promise<string | null> {
    return this.rootPath;
  }
  async scan(full: boolean): Promise<FolderEntry[]> {
    this.scans.push({ full });
    if (this.rootPath === null) throw new Error("no_root");
    if (this.missing) throw new Error("root_missing");
    const entries: FolderEntry[] = [...this.files].map(([path, f]) => ({
      path,
      size: Buffer.byteLength(f.content),
      mtimeMs: f.mtimeMs,
      hash: sha256Hex(f.content),
      status: "ok" as const,
    }));
    return [...entries, ...this.extra];
  }
  async read(path: string): Promise<string> {
    const f = this.files.get(path);
    if (!f) throw new Error("missing");
    return f.content;
  }
  async write(
    path: string,
    content: string,
    expectedHash: string | null,
  ): Promise<WriteResult> {
    const check = () => {
      const cur = this.files.get(path);
      if (expectedHash === null) return cur ? ("exists" as const) : null;
      if (!cur || sha256Hex(cur.content) !== expectedHash)
        return "changed" as const;
      return null;
    };
    const first = check();
    if (first) return { result: first };
    this.beforeApply?.(path);
    const again = check(); // the host re-checks right before the rename
    if (again) return { result: again };
    this.files.set(path, { content, mtimeMs: this.clock++ });
    this.emit(); // our own write is a watcher event too
    return { result: "written", hash: sha256Hex(content) };
  }
  async rename(
    from: string,
    to: string,
    expectedHash: string,
  ): Promise<RenameResult> {
    const f = this.files.get(from);
    if (!f) return "missing";
    if (sha256Hex(f.content) !== expectedHash) return "changed";
    if (this.files.has(to)) return "exists";
    this.files.delete(from);
    this.files.set(to, f);
    this.emit();
    return "renamed";
  }
  async trash(path: string, expectedHash: string): Promise<TrashResult> {
    const f = this.files.get(path);
    if (!f) return "missing";
    if (sha256Hex(f.content) !== expectedHash) return "changed";
    this.files.delete(path);
    this.trashed.push({ path, content: f.content });
    this.emit();
    return "trashed";
  }
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
}

export class FakeNotifier implements NotifierPort {
  perm: NotifyPermission = "granted";
  shown: Array<{ title: string; body: string; tag: string | null }> = [];
  async permission(): Promise<NotifyPermission> {
    return this.perm;
  }
  async requestPermission(): Promise<NotifyPermission> {
    if (this.perm === "default") this.perm = "granted";
    return this.perm;
  }
  async show(input: {
    title: string;
    body: string;
    tag: string | null;
  }): Promise<void> {
    if (this.perm !== "granted") throw new Error("permission denied");
    this.shown.push(input);
  }
}

export class FakeTray implements TrayPort {
  closeToTray: boolean | null = null;
  status = "";
  private menu = new Set<(item: "open" | "sync_now") => void>();
  async setCloseToTray(enabled: boolean): Promise<void> {
    this.closeToTray = enabled;
  }
  async setStatus(text: string): Promise<void> {
    this.status = text;
  }
  onMenu(listener: (item: "open" | "sync_now") => void): () => void {
    this.menu.add(listener);
    return () => void this.menu.delete(listener);
  }
  click(item: "open" | "sync_now"): void {
    for (const l of this.menu) l(item);
  }
}

export class FakeAutostart implements AutostartPort {
  enabled = false;
  async isEnabled(): Promise<boolean> {
    return this.enabled;
  }
  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
  }
}

export class FakeLifecycle implements LifecyclePort {
  windowShown = 0;
  signInPage: Array<"signed_out" | "update_required" | null> = [];
  quit_ = 0;
  private wake = new Set<() => void>();
  onWake(listener: () => void): () => void {
    this.wake.add(listener);
    return () => void this.wake.delete(listener);
  }
  fireWake(): void {
    for (const l of this.wake) l();
  }
  async showWindow(): Promise<void> {
    this.windowShown++;
  }
  async gotoSignIn(
    reason: "signed_out" | "update_required" | null,
  ): Promise<void> {
    this.signInPage.push(reason);
  }
  async quit(): Promise<void> {
    this.quit_++;
  }
}

/**
 * A fake Android alarm service: like AlarmManager it fires by itself (here: when the test calls `osTick`) whether or not the
 * runtime is running, remembers what it delivered, and keeps alarms across a "reboot" only when the plugin re-arms them (it does).
 */
export class FakeAlarms implements AlarmPort {
  pending = new Map<number, AlarmSpec>();
  private deliveredLog: number[] = [];
  /** notifications currently in the shade (id -> alarm) */
  shade = new Map<number, AlarmSpec>();
  statusValue: AlarmStatus = {
    notifications: "granted",
    exactAlarms: true,
    ignoringBatteryOptimizations: false,
    manufacturer: "OnePlus",
    sdk: 34,
  };
  launchTask: string | null = null;
  opened: string[] = [];
  keepConnectedOn = false;
  keepConnected = {
    get: async () => this.keepConnectedOn,
    set: async (on: boolean) => {
      this.keepConnectedOn = on;
    },
  };
  constructor(private readonly now: () => number) {}
  async schedule(alarm: AlarmSpec): Promise<void> {
    this.pending.set(alarm.id, { ...alarm });
  }
  async cancel(id: number): Promise<void> {
    this.pending.delete(id);
  }
  async list(): Promise<Array<{ id: number; at: number }>> {
    return [...this.pending.values()].map((a) => ({ id: a.id, at: a.at }));
  }
  async delivered(): Promise<number[]> {
    const ids = new Set([...this.deliveredLog, ...this.shade.keys()]);
    this.deliveredLog = [];
    return [...ids];
  }
  async clearShown(ids: number[]): Promise<void> {
    for (const id of ids) this.shade.delete(id);
  }
  async status(): Promise<AlarmStatus> {
    return this.statusValue;
  }
  async openSettings(which: string): Promise<void> {
    this.opened.push(which);
  }
  async takeLaunchTask(): Promise<string | null> {
    const t = this.launchTask;
    this.launchTask = null;
    return t;
  }
  /** The OS fires what is due (runs with the app closed too). */
  osTick(): number[] {
    const fired: number[] = [];
    for (const a of [...this.pending.values()]) {
      if (a.at <= this.now()) {
        this.pending.delete(a.id);
        this.deliveredLog.push(a.id);
        this.shade.set(a.id, a);
        fired.push(a.id);
      }
    }
    return fired;
  }
}

export interface FakePlatform extends PlatformPort {
  db: FakeRowDb;
  http: FakeHttp;
  session: FakeSession;
  folder: FakeFolder;
  notifier: FakeNotifier;
  alarms?: FakeAlarms;
  tray: FakeTray;
  autostart: FakeAutostart;
  lifecycle: FakeLifecycle;
  timers: FakeTimers;
  crypto: FakeCrypto;
}

export function createFakePlatform(
  seed = 7,
  options: { android?: boolean } = {},
): FakePlatform {
  const timers = new FakeTimers();
  return {
    db: new FakeRowDb(),
    http: new FakeHttp(),
    session: new FakeSession(),
    folder: new FakeFolder(),
    notifier: new FakeNotifier(),
    tray: new FakeTray(),
    autostart: new FakeAutostart(),
    lifecycle: new FakeLifecycle(),
    timers,
    crypto: new FakeCrypto(seed),
    ...(options.android ? { alarms: new FakeAlarms(() => timers.wall) } : {}),
  };
}
