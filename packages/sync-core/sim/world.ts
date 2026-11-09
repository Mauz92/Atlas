/**
 * The simulated world (SYNC-08): N clients running the REAL sync-core over an in-memory
 * `LocalStore`, a fault-injecting network, a server (the TS model or the real API) and a seeded,
 * virtual-time schedule. A run is fully described by `(seed, SimConfig, bugs)`; every failure prints
 * the seed and the tail of the trace, so it reproduces with `ATLAS_SYNC_SEED=<seed>`.
 *
 * Mirrors `services/api/tests/sim/runner.py`.
 */

import { SyncEngine, type EngineObserver, type PlantedBugs } from "../src/engine.ts";
import type { Clock, Logger, Transport } from "../src/ports.ts";
import { MemoryStore, InjectedCrash } from "../src/testing/memoryStore.ts";
import { sequenceIds } from "../src/testing/fakes.ts";
import type { QueueOp } from "../src/types.ts";
import { FLAG, FLAG_VALUES, LABEL, type Req, type Resp, type SimKind } from "./model/common.ts";
import type { ServerPort } from "./engineBridge.ts";
import { toReq, toResponse } from "./engineBridge.ts";
import { rng, type Rng } from "./prng.ts";
import { checkCursorSafety } from "./invariants.ts";
import { HOUR, MIN, REM_MS_PER_VMS, REM_T0, ReminderDevice } from "./reminderDevice.ts";
import { checkReminderStep } from "./reminderInvariants.ts";
import type { PlantedBugs as SchedulerBugs } from "../../reminder-core/src/desired.ts";

export interface SimConfig {
  clients: number;
  steps: number;
  actionP: number;
  pDropRequest: number;
  pDropResponse: number;
  pDuplicate: number;
  pServerError: number;
  pSlow: number;
  pToggleOnline: number;
  pRestart: number;
  pClockJump: number;
  pPurge: number;
  /** Chance per transaction that the client process dies before it commits (nothing is kept). */
  pStoreCrash: number;
  maxClockSkew: number;
  skew: boolean;
  timeout: number;
  maxQuiesceTicks: number;
  kinds: readonly ("task" | "project" | "note")[];
  lateJoiner: boolean;
  oldClient: boolean;
  resolutions: boolean;
  undoRounds: number;
  /** Client id whose device the owner revokes after `revokeAt` of the steps. */
  revokeClient: string | null;
  revokeAt: number;
  /** Engine option overrides (page size etc.). */
  pageSize: number;
  /** Upper bound of the one-way network latency in virtual ms (the reminder runs use a fast network). */
  maxLatency: number;
  /** Upper bound of the virtual time one step advances (the reminder runs use short steps). */
  stepMs: number;
  /** Scales the engine's timers (backoff, pull interval, request timeout) and the slow-network delay with the step length. */
  timeScale: number;
  /**
   * M8-04b-ii: every client also runs the device scheduler over its engine; tasks carry `due_at` and
   * `status`; the engine syncs the `reminder` entity. The reminder timeline is 1 virtual ms = 5 minutes.
   */
  reminders: boolean;
  /** The reminder timeline is the real wall clock (a real server computes snoozes from its own clock). */
  realClock: boolean;
  /** Clients start WITHOUT the reminder type and are "upgraded" to it mid-run (backfill, G7). */
  reminderUpgrade: boolean;
  /** Test-only scheduler defects (reminder-core `PlantedBugs`). */
  schedulerBugs: SchedulerBugs;
}

export const DEFAULT_CONFIG: SimConfig = {
  clients: 3,
  steps: 120,
  actionP: 0.35,
  pDropRequest: 0.07,
  pDropResponse: 0.1,
  pDuplicate: 0.06,
  pServerError: 0.04,
  pSlow: 0.1,
  pToggleOnline: 0.04,
  pRestart: 0.03,
  pClockJump: 0.05,
  pPurge: 0,
  pStoreCrash: 0.02,
  maxClockSkew: 86_400_000,
  skew: true,
  timeout: 120,
  maxQuiesceTicks: 4000,
  kinds: ["task", "project"],
  lateJoiner: false,
  oldClient: false,
  resolutions: false,
  undoRounds: 40,
  revokeClient: null,
  revokeAt: 0.5,
  pageSize: 4,
  maxLatency: 25,
  stepMs: 15,
  timeScale: 1,
  reminders: false,
  realClock: false,
  reminderUpgrade: false,
  schedulerBugs: {},
};

export class SimFailure extends Error {
  constructor(
    readonly seed: number,
    readonly invariant: string,
    detail: string,
    trace: string[],
  ) {
    super(
      `[sim seed=${seed}] invariant '${invariant}' violated: ${detail}\n` +
        `  reproduce: ATLAS_SYNC_SEED=${seed} npm --prefix packages/sync-core test\n` +
        `  last events:\n    ${trace.slice(-30).join("\n    ")}`,
    );
  }
}

// --- virtual time and network -----------------------------------------------------------------

type Callback = () => Promise<void> | void;

export class EventQueue {
  now = 0;
  private heap: { time: number; n: number; fn: Callback }[] = [];
  private counter = 0;

  at(delay: number, fn: Callback): void {
    this.heap.push({ time: this.now + Math.max(0, delay), n: ++this.counter, fn });
    this.heap.sort((a, b) => a.time - b.time || a.n - b.n);
  }

  async runDue(): Promise<void> {
    while (this.heap.length > 0 && this.heap[0]!.time <= this.now) {
      const item = this.heap.shift()!;
      await item.fn();
    }
  }

  pending(): number {
    return this.heap.length;
  }
}

export class Network {
  faults = true;
  online = new Map<string, boolean>();

  constructor(
    private readonly events: EventQueue,
    private readonly server: ServerPort,
    private readonly r: Rng,
    private readonly cfg: SimConfig,
    private readonly trace: string[],
  ) {}

  /** Send; `onReply` is called with the response, or never if the reply is lost. */
  send(cid: string, req: Req, onReply: (resp: Resp) => void): void {
    const { cfg, r } = this;
    const roll = this.faults ? r.next() : 1;
    const slow = this.faults && r.next() < cfg.pSlow ? Math.round(150 * cfg.timeScale) : 0;
    const up = r.range(1, cfg.maxLatency) + slow;
    const down = r.range(1, cfg.maxLatency) + (this.faults && r.next() < cfg.pSlow ? Math.round(150 * cfg.timeScale) : 0);
    const dropReq = roll < cfg.pDropRequest;
    const edge = cfg.pDropRequest + cfg.pDropResponse;
    const dropResp = cfg.pDropRequest <= roll && roll < edge;
    const duplicate = edge <= roll && roll < edge + cfg.pDuplicate;
    const err = edge + cfg.pDuplicate <= roll && roll < edge + cfg.pDuplicate + cfg.pServerError;
    const label = `${cid} ${req.method} ${req.path}`;
    if (dropReq) {
      this.trace.push(`t=${this.events.now} net DROP-REQUEST ${label}`);
      return;
    }
    const arrive = async (deliver = true): Promise<void> => {
      const resp = await this.server.handle(req);
      if (dropResp || !deliver) {
        if (dropResp && deliver)
          this.trace.push(`t=${this.events.now} net DROP-RESPONSE (applied) ${label} -> ${resp.status}`);
        return;
      }
      let out = resp;
      if (err) {
        this.trace.push(`t=${this.events.now} net 503-AFTER-APPLY ${label}`);
        out = { status: 503, body: { detail: "injected" } };
      }
      this.events.at(down, () => {
        if (!(this.online.get(cid) ?? true)) {
          this.trace.push(`t=${this.events.now} net reply lost (offline) ${label}`);
          return;
        }
        onReply(out);
      });
    };
    this.events.at(up, () => arrive());
    if (duplicate) {
      this.trace.push(`t=${this.events.now} net DUPLICATE ${label}`);
      this.events.at(up + r.range(1, 60), () => arrive(false));
    }
  }
}

// --- recorder ---------------------------------------------------------------------------------

export interface AckRecord {
  cid: string;
  op: QueueOp;
  status: number;
  body: unknown;
}

export class Recorder {
  acks: AckRecord[] = [];
  refusals: { cid: string; op: QueueOp; status: number; code: string | null }[] = [];
  halts = new Map<string, string>();
  conflictCopies: { cid: string; op: QueueOp; copy: Record<string, unknown> }[] = [];
  seenResolutions = new Map<string, { opKey: string; out: Record<string, unknown> }>();
  winners = new Map<string, unknown>();
  undos: { cid: string; op: QueueOp; status: number; body: Record<string, unknown> }[] = [];
  undoRefusals: { cid: string; op: QueueOp; status: number; code: string | null }[] = [];
  selfInflicted: string[] = [];
  /** the request bytes of the first send of each operation */
  firstSend = new Map<string, string>();
  /** note lines users typed and removed (a marker is "m:<client>-<n>...") */
  added = new Set<string>();
  /** where each typed line came from (debugging a loss) */
  origin = new Map<string, string>();
  removed = new Set<string>();
  /** the first send of each queued reminder action: its body and the device clock at that moment (R-68) */
  firstSendByKey = new Map<string, { wall: number; body: Record<string, unknown> }>();
  /** the entities users deleted themselves */
  logLines: { client: string; event: string; fields: Record<string, unknown> }[] = [];
}

export const markers = (text: string | null): Set<string> =>
  new Set((text ?? "").split("\n").filter((line) => line.startsWith("m:")));

// --- clients ----------------------------------------------------------------------------------

const NOTE_PATHS = ["a.md", "A.md", "b.md", "dir/a.md", "dir/A.md", "dir/b.md", "c d.md"];

export class SimClient {
  readonly store = new MemoryStore();
  engine!: SyncEngine;
  gen = 0;
  active = true;
  offset = 0;
  sentBefore = 0;
  sentAtHalt = -1;
  private haltedFlag = false;
  device: ReminderDevice | null = null;
  /** The engine syncs `reminder` (false before a mid-run upgrade). */
  remindersOn: boolean;

  get halted(): boolean {
    return this.haltedFlag || this.engine.debug().halted !== null;
  }

  set halted(value: boolean) {
    this.haltedFlag = value;
  }
  /** the owner's device revoked: the client is done once it has been told */
  readonly rng: Rng;

  constructor(
    readonly cid: string,
    private readonly world: World,
    readonly protocol: number,
    private readonly bugs: PlantedBugs,
  ) {
    this.rng = rng(world.seed, `user:${cid}`);
    this.remindersOn = !world.cfg.reminderUpgrade;
    this.engine = this.build();
    if (world.cfg.reminders) {
      const desktop = world.cfg.clients > 1 && cid === `c${world.cfg.clients}`;
      this.device = new ReminderDevice(this, () => world.remNow(), desktop, world.cfg.schedulerBugs, hash(`${world.seed}:${cid}:act`));
    }
  }

  sentTotal(): number {
    return this.sentBefore + this.engine.sent;
  }

  private build(): SyncEngine {
    const w = this.world;
    const cid = this.cid;
    const clock: Clock = {
      monotonic: () => w.events.now,
      // with reminders the wall clock IS the device clock of the scheduler (R-68 reads the delay from it)
      wallTime: () => (w.cfg.reminders ? w.remNow() + this.offset : w.events.now + this.offset),
    };
    const transport: Transport = {
      send: (request) =>
        new Promise((resolve) => {
          const req = toReq(request, {
            "X-Sim-Client": cid,
            "X-Client-Time": String(clock.wallTime()),
          });
          w.net.send(cid, req, (resp) => resolve(toResponse(resp)));
        }),
    };
    const logger: Logger = {
      debug: (e, f) => w.log(cid, e, f),
      info: (e, f) => w.log(cid, e, f),
      warn: (e, f) => w.log(cid, e, f),
      error: (e, f) => w.log(cid, e, f),
    };
    const observer: EngineObserver = {
      sending: (op, request) => {
        const bytes = JSON.stringify({
          m: request.method,
          p: request.path,
          q: request.query,
          b: request.body,
          k: request.headers["Idempotency-Key"],
        });
        const first = w.rec.firstSend.get(op.id);
        if (op.type === "reminder" && !w.rec.firstSendByKey.has(op.key))
          w.rec.firstSendByKey.set(op.key, { wall: clock.wallTime(), body: { ...(request.body as Record<string, unknown>) } });
        if (first === undefined) w.rec.firstSend.set(op.id, bytes);
        else if (first !== bytes)
          w.rec.selfInflicted.push(`${cid}: a retry of ${op.action} ${op.id.slice(0, 8)} was not byte-identical`);
      },
      ack: (op, resp) => {
        w.rec.acks.push({ cid, op, status: resp.status, body: resp.body });
        this.noteResolutions(op, resp.status, resp.body);
        this.device?.onAck(op, [...this.store.peek().queue.values()]);
      },
      pullStarted: () => this.device?.onPullStarted(),
      pullCompleted: () => this.device?.onPullCompleted(),
      refused: (op, resp) => {
        const body = resp.body as Record<string, unknown> | null;
        const code = typeof body?.["error"] === "string" ? (body["error"] as string) : null;
        w.rec.refusals.push({ cid, op, status: resp.status, code });
        const copy = body?.["conflict_copy"] as Record<string, unknown> | undefined;
        if (copy) w.rec.conflictCopies.push({ cid, op, copy });
        this.noteResolutions(op, resp.status, resp.body);
      },
      undone: (op, resp) => {
        const body = resp.body as Record<string, unknown>;
        w.rec.undos.push({ cid, op, status: resp.status, body });
        const entry = body["undo"] as Record<string, unknown>;
        if (entry?.["id"]) w.rec.seenResolutions.set(entry["id"] as string, { opKey: op.key, out: entry });
      },
      undoRefused: (op, resp) => {
        const body = resp.body as Record<string, unknown> | null;
        w.rec.undoRefusals.push({
          cid, op, status: resp.status,
          code: typeof body?.["error"] === "string" ? (body["error"] as string) : null,
        });
      },
      halted: (halt) => {
        this.halted = true;
        this.sentAtHalt = this.sentTotal();
        w.rec.halts.set(cid, halt.kind);
        w.trace.push(`t=${w.events.now} ${cid} HALTED ${halt.kind}`);
      },
    };
    const engine = new SyncEngine({
      store: this.store,
      transport,
      clock,
      ids: sequenceIds(hash(`${w.seed}:${cid}:${this.gen}`)),
      random: rng(w.seed, `jitter:${cid}:${this.gen}`),
      logger,
      observer,
      options: {
        protocol: this.protocol,
        pageSize: w.cfg.pageSize,
        requestTimeoutMs: Math.round(w.cfg.timeout * w.cfg.timeScale),
        backoff: { baseMs: 40 * w.cfg.timeScale, factor: 2, capMs: 400 * w.cfg.timeScale },
        pullIntervalMs: 30 * w.cfg.timeScale,
        pullJitterMs: 20 * w.cfg.timeScale,
        resyncMinIntervalMs: 0,
        trackResolutions: w.cfg.resolutions,
        reminders: w.cfg.reminders && this.remindersOn,
        plantedBugs: this.bugs,
      },
    });
    return engine;
  }

  private noteResolutions(op: QueueOp, status: number, bodyAny: unknown): void {
    const body = bodyAny as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return;
    const outs: Record<string, unknown>[] = [];
    const sync = body["sync"] as { resolution?: Record<string, unknown>[] } | undefined;
    if (sync?.resolution) outs.push(...sync.resolution);
    if (Array.isArray(body["resolution"])) outs.push(...(body["resolution"] as Record<string, unknown>[]));
    for (const out of outs) {
      if (!out["id"]) continue;
      this.world.rec.seenResolutions.set(out["id"] as string, { opKey: op.key, out });
      if (status >= 200 && status < 300 && ["simple_later_wins", "path_later_wins"].includes(out["rule"] as string) && out["field"])
        this.world.rec.winners.set(out["id"] as string, body[out["field"] as string]);
    }
  }

  /** A crash: everything volatile is lost; the durable store is what the next run sees. */
  restart(): void {
    this.world.trace.push(`t=${this.world.events.now} ${this.cid} RESTART (volatile state lost)`);
    this.sentBefore += this.engine.sent;
    this.engine.dispose();
    this.gen++;
    this.engine = this.build();
    this.device?.boot();
  }

  /** The app is updated to a build that syncs reminders: a new process with the option on (G7). */
  upgrade(): void {
    if (this.remindersOn) return;
    this.remindersOn = true;
    this.world.trace.push(`t=${this.world.events.now} ${this.cid} UPGRADES to a build that syncs reminders`);
    this.restart();
  }

  /** What a host does after a pull, an edit or a tick: reconcile the scheduler and let the OS fire. */
  async pumpDevice(): Promise<void> {
    if (!this.device || !this.active) return;
    await this.device.pump();
    // judged at once: the owner's next action must not change the verdict on what was shown before it
    await checkReminderStep(this.world, this);
  }

  async tick(): Promise<void> {
    if (!(this.world.net.online.get(this.cid) ?? true)) return;
    await this.engine.tick();
  }

  // --- user actions ---------------------------------------------------------------------------

  async guarded(fn: () => Promise<unknown>): Promise<boolean> {
    const saved = this.store.crashBeforeCommit;
    this.store.crashBeforeCommit = null; // a user action is not a crash point
    try {
      await fn();
      return true;
    } catch (error) {
      if (error instanceof InjectedCrash) throw error;
      // a refused user action (deleted entity, text not downloaded): the user simply could not act
      return false;
    } finally {
      this.store.crashBeforeCommit = saved;
    }
  }

  async userAction(kinds: SimConfig["kinds"]): Promise<void> {
    if (!this.active || this.halted) return;
    const w = this.world;
    const r = this.rng;
    this.counter++;
    const opId = `${this.cid}-${this.counter}`;
    if (w.cfg.resolutions && (await this.undoAction(false))) return;
    if (w.cfg.reminders && r.next() < 0.6 && (await this.reminderAction(opId))) return;
    if (kinds.includes("note") && r.next() < (kinds.length === 1 ? 1 : 0.4)) {
      await this.noteAction(opId);
      return;
    }
    const views = await this.engine.views();
    const targets = views.filter((v) => v.type !== "note" && !v.deleted);
    const deletedTasks = views.filter((v) => v.type === "task" && v.deleted);
    const roll = r.next();
    const flagged = kinds.filter((k) => k !== "note") as SimKind[];
    if (roll < 0.3 || targets.length === 0) {
      const kind = r.pick(flagged.length ? flagged : (["task"] as SimKind[]));
      const fields: Record<string, string | null> = { [LABEL[kind]]: `${kind}:${opId}`, description: null };
      if (r.next() < 0.4) fields[FLAG[kind]] = r.pick(FLAG_VALUES[kind]);
      await this.guarded(() => this.engine.createEntity(kind, fields));
    } else if (roll < 0.76) {
      const target = r.pick(targets);
      const kind = target.type as SimKind;
      const changed: Record<string, string> = {};
      if (r.next() < 0.5) changed[LABEL[kind]] = `${kind}:${opId}`;
      if (r.next() < 0.4) changed["description"] = `d:${opId}`;
      if (r.next() < 0.5 || Object.keys(changed).length === 0) changed[FLAG[kind]] = r.pick(FLAG_VALUES[kind]);
      await this.guarded(() => this.engine.updateEntity(kind, target.id, changed));
    } else if (roll < 0.9) {
      const target = r.pick(targets);
      await this.guarded(() => this.engine.deleteEntity(target.type, target.id));
    } else if (deletedTasks.length > 0) {
      const target = r.pick(deletedTasks);
      await this.guarded(() => this.engine.restoreTask(target.id));
    }
  }

  counter = 0;

  /** The reminder-flavoured owner actions (M8-04b-ii). Returns whether one was made. */
  private async reminderAction(opId: string): Promise<boolean> {
    const w = this.world;
    const r = this.rng;
    const dev = this.device!;
    const roll = r.next();
    const tasks = (await this.engine.views()).filter((v) => v.type === "task" && !v.deleted);
    const iso = (ms: number) => new Date(ms).toISOString();
    if (dev.os.shade.size > 0 && r.next() < 0.5) {
      await this.guarded(() => dev.ownerActs());
      return true;
    }
    if (roll < 0.28 || tasks.length === 0) {
      const due = iso(w.remNow() + r.range(-2 * HOUR, 30 * HOUR));
      await this.guarded(() => this.engine.createEntity("task", { title: `task:${opId}`, description: null, due_at: due, status: "inbox" }));
      return true;
    }
    if (roll < 0.5) {
      const withDue = tasks.filter((t) => typeof t.fields["due_at"] === "string" && t.fields["status"] !== "completed");
      if (withDue.length === 0) return false;
      const target = r.pick(withDue);
      let due = iso(w.remNow() + r.range(-2 * HOUR, 30 * HOUR));
      if (due === target.fields["due_at"]) due = iso(Date.parse(due) + MIN);
      await dev.noteRedate(target.id);
      if (!(await this.guarded(() => this.engine.updateEntity("task", target.id, { due_at: due })))) dev.dropRedate(target.id);
      return true;
    }
    if (roll < 0.64) {
      const open = tasks.filter((t) => t.fields["status"] !== "completed");
      if (open.length === 0) return false;
      const target = r.pick(open);
      await this.guarded(() => this.engine.updateEntity("task", target.id, { status: "completed" }));
      return true;
    }
    if (roll < 0.72) {
      const done = tasks.filter((t) => t.fields["status"] === "completed");
      if (done.length === 0) return false;
      await this.guarded(() => this.engine.updateEntity("task", r.pick(done).id, { status: "in_progress" }));
      return true;
    }
    if (roll < 0.95) {
      await this.guarded(() => dev.ownerActs());
      return true;
    }
    return false;
  }

  async undoTap(): Promise<void> {
    this.counter++;
    await this.undoAction(true);
  }

  private async undoAction(force: boolean): Promise<boolean> {
    const r = this.rng;
    const known = await this.engine.resolutions();
    const undoable = known.filter((n) => n.undoable);
    if (known.length === 0 || r.next() >= (undoable.length > 0 || force ? 0.7 : 0.1)) return false;
    const pool = undoable.length === 0 || r.next() < 0.2 ? known : undoable;
    const target = r.next() < 0.7 ? pool[pool.length - 1]! : r.pick(pool);
    await this.guarded(() => this.engine.undoResolution(target.id));
    return true;
  }

  private edited(text: string): string {
    const r = this.rng;
    this.counter++;
    const marker = `m:${this.cid}-${this.counter}`;
    const finalNewline = text.endsWith("\n");
    const body = text === "" ? [] : text.split("\n").slice(0, finalNewline ? -1 : undefined);
    const roll = r.next();
    if (roll < 0.7 || body.length === 0) body.splice(r.int(body.length + 1), 0, marker);
    else if (roll < 0.85) body[r.int(body.length)] = marker;
    else body.splice(r.int(body.length), 1);
    return body.join("\n") + (finalNewline && body.length ? "\n" : "");
  }

  private async noteAction(opId: string): Promise<void> {
    const r = this.rng;
    const rec = this.world.rec;
    const notes = (await this.engine.views()).filter((v) => v.type === "note" && !v.deleted);
    const roll = r.next();
    if (notes.length === 0 || (notes.length < 4 && roll < 0.25) || roll < 0.04) {
      const count = r.range(10, 25);
      const lines = Array.from({ length: count }, (_, k) => `m:${this.cid}-${this.counter}.${k}`);
      const text = lines.join("\n") + (r.next() < 0.7 ? "\n" : "");
      if (await this.guarded(() => this.engine.createNote(r.pick(NOTE_PATHS), text)))
        markers(text).forEach((m) => rec.added.add(m));
      return;
    }
    const target = r.pick(notes);
    if (roll < 0.78) {
      if (target.content === null) return;
      const next = this.edited(target.content);
      const before = markers(target.content);
      const after = markers(next);
      if (await this.guarded(() => this.engine.editNote(target.id, next))) {
        after.forEach((m) => {
          if (!before.has(m)) {
            rec.added.add(m);
            rec.origin.set(m, `${this.cid} t=${this.world.events.now} edit of note ${target.id.slice(0, 8)} pending=${target.pendingOps}`);
          }
        });
        before.forEach((m) => !after.has(m) && rec.removed.add(m));
      }
    } else if (roll < 0.94) {
      await this.guarded(() => this.engine.moveNote(target.id, r.pick(NOTE_PATHS)));
    } else {
      if (await this.guarded(() => this.engine.deleteEntity("note", target.id)))
        markers(target.content).forEach((m) => rec.removed.add(m));
    }
    void opId;
  }
}

function hash(label: string): number {
  let h = 2166136261;
  for (const ch of label) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

// --- the world --------------------------------------------------------------------------------

export class World {
  readonly events = new EventQueue();
  readonly trace: string[] = [];
  readonly rec = new Recorder();
  readonly r: Rng;
  readonly clockRng: Rng;
  readonly net: Network;
  readonly clients: SimClient[] = [];
  stepsRun = 0;
  /** Extra virtual time added to the reminder timeline after quiescence (the sweep). */
  sweep = 0;
  /** The reminder timeline stops here while the clients settle, so the sweep starts where the run ended. */
  private remFrozen: number | null = null;
  /** The server was restored from a backup: feed rows below a client's cursor may be gone. */
  restored = false;

  constructor(
    readonly seed: number,
    readonly cfg: SimConfig,
    readonly server: ServerPort,
    bugs: PlantedBugs = {},
  ) {
    this.r = rng(seed, "net");
    this.clockRng = rng(seed, "clock");
    this.net = new Network(this.events, server, this.r, cfg, this.trace);
    if (cfg.reminders) {
      const model = (server as { constructor: { name: string }; options?: { clock?: () => number } });
      if (model.constructor.name === "ModelServer" && model.options) model.options.clock = () => this.remNow();
    }
    const names = Array.from({ length: cfg.clients }, (_, i) => `c${i + 1}`);
    if (cfg.oldClient) names.push("old");
    for (const cid of names) {
      this.net.online.set(cid, true);
      const client = new SimClient(cid, this, cid === "old" ? 2 : 1, bugs);
      client.offset = cfg.skew ? this.clockRng.range(-cfg.maxClockSkew, cfg.maxClockSkew) : 0;
      this.clients.push(client);
    }
    for (const client of this.clients) {
      client.store.crashBeforeCommit = null;
    }
  }

  /** The reminder timeline: 1 virtual ms = 5 minutes, plus the post-quiescence sweep. */
  remNow(): number {
    if (this.cfg.realClock) return Date.now() + this.sweep;
    return (this.remFrozen ?? REM_T0 + this.events.now * REM_MS_PER_VMS) + this.sweep;
  }

  fail(invariant: string, detail: string): SimFailure {
    return new SimFailure(this.seed, invariant, detail, this.trace);
  }

  log(client: string, event: string, fields: Record<string, unknown> = {}): void {
    this.rec.logLines.push({ client, event, fields });
    if (this.trace.length > 40_000) this.trace.splice(0, 20_000);
    this.trace.push(`t=${this.events.now} ${client} ${event} ${JSON.stringify(fields)}`);
  }

  /** Let every pending promise continuation run (the engines and stores are microtask-only). */
  async settle(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  private crashHook(): () => boolean {
    const r = rng(this.seed, "store-crash");
    return () => this.net.faults && r.next() < this.cfg.pStoreCrash;
  }

  async faultyPhase(hooks: { onStep?: (step: number) => Promise<void> } = {}): Promise<void> {
    const { cfg, r } = this;
    const joiner = cfg.lateJoiner ? this.clients[cfg.clients - 1]! : null;
    if (joiner) {
      this.net.online.set(joiner.cid, false);
      joiner.active = false;
    }
    for (const client of this.clients) client.store.crashBeforeCommit = this.crashHook();
    for (let step = 0; step < cfg.steps; step++) {
      this.stepsRun = step;
      if (joiner && step === Math.floor(cfg.steps * 0.6)) {
        joiner.active = true;
        this.net.online.set(joiner.cid, true);
        joiner.engine.retryNow();
        this.trace.push(`t=${this.events.now} ${joiner.cid} JOINS with an empty store`);
      }
      if (cfg.revokeClient && step === Math.floor(cfg.steps * cfg.revokeAt)) {
        const server = this.server as unknown as { revokeDevice(cid: string): Promise<void> };
        await server.revokeDevice(cfg.revokeClient);
        this.trace.push(`t=${this.events.now} OWNER revokes the device of ${cfg.revokeClient}`);
      }
      if (hooks.onStep) await hooks.onStep(step);
      if (cfg.reminders && cfg.reminderUpgrade) {
        this.clients.forEach((client, i) => {
          if (step === Math.floor(cfg.steps * 0.35) + i * 4) client.upgrade();
        });
      }
      this.events.now += r.range(1, cfg.stepMs);
      await this.events.runDue();
      await this.settle();
      for (const client of this.clients) await client.pumpDevice();
      for (const client of this.clients) {
        if (r.next() < cfg.actionP) {
          await client.userAction(cfg.kinds);
          await client.pumpDevice();
        }
      }
      for (const client of this.clients) {
        if (client === joiner && !joiner.active) continue;
        if (r.next() < cfg.pToggleOnline) {
          const online = !this.net.online.get(client.cid);
          this.net.online.set(client.cid, online);
          this.trace.push(`t=${this.events.now} ${client.cid} ${online ? "ONLINE" : "OFFLINE"}`);
          if (online) client.engine.retryNow();
        }
        if (r.next() < cfg.pRestart) client.restart();
        if (cfg.reminders && client.device && client.active) {
          const dev = client.device;
          const roll = client.rng.next();
          if (roll < 0.015) {
            this.trace.push(`t=${this.events.now} ${client.cid} OS reboot`);
            await dev.reboot(client.rng.next() < 0.8);
          } else if (roll < 0.03) {
            dev.os.permissionState = dev.os.permissionState === "granted" ? "denied" : "granted";
            this.trace.push(`t=${this.events.now} ${client.cid} notification permission ${dev.os.permissionState}`);
          }
        }
        const jump = this.clockRng.next() < cfg.pClockJump;
        const amount = this.clockRng.range(-cfg.maxClockSkew, cfg.maxClockSkew);
        if (jump && cfg.skew) client.offset = amount;
      }
      const model = this.model();
      if (model && cfg.pPurge && r.next() < cfg.pPurge) {
        const cutoff = r.range(0, model.headSeq);
        model.purge(cutoff);
        this.trace.push(`t=${this.events.now} SERVER purge feed up to ${cutoff}`);
      }
      for (const client of this.clients) await client.tick();
      await this.settle();
      for (const client of this.clients) await checkCursorSafety(this, client);
      for (const client of this.clients) await client.pumpDevice();
    }
  }

  model(): import("./model/server.ts").ModelServer | null {
    const s = this.server as { constructor: { name: string } };
    return s.constructor.name === "ModelServer" ? (this.server as never) : null;
  }

  async quiesce(): Promise<void> {
    if (this.cfg.reminders && this.remFrozen === null) this.remFrozen = REM_T0 + this.events.now * REM_MS_PER_VMS;
    this.net.faults = false;
    for (const cid of this.net.online.keys()) this.net.online.set(cid, true);
    for (const client of this.clients) client.engine.retryNow();
    this.trace.push(`t=${this.events.now} --- quiescence (faults off, all online) ---`);
    const tickMs = Math.max(1, Math.round(10 * this.cfg.timeScale));
    for (let i = 0; i < this.cfg.maxQuiesceTicks; i++) {
      this.events.now += tickMs;
      await this.events.runDue();
      await this.settle();
      for (const client of this.clients) await client.tick();
      await this.settle();
      if (await this.quiescent()) return;
    }
    const stuck = await Promise.all(
      this.clients.map(async (c) => {
        const status = await c.engine.getStatus();
        return `${c.cid}: pending=${status.pending} state=${status.state} cursor=${status.cursor} clean=${c.engine.cleanPulls} engine=${JSON.stringify(c.engine.debug())}`;
      }),
    );
    throw this.fail("bounded_work", `did not quiesce within ${this.cfg.maxQuiesceTicks} ticks after faults stopped: ${stuck.join("; ")}`);
  }

  private async quiescent(): Promise<boolean> {
    if (this.events.pending() > 0) return false;
    const head = await this.server.head();
    for (const client of this.clients) {
      if (client.halted) continue;
      if (client.cid === this.cfg.revokeClient) return false; // done only once it has been told
      if (!(await client.engine.isIdle())) return false;
      if (client.engine.cleanPulls < 2) return false;
      const cursor = (await client.store.transaction(async (tx) => tx.getMeta<number>("cursor"))) ?? 0;
      if (cursor !== head) return false;
    }
    return true;
  }

  /** Second wave (SYNC-05): clients holding the whole run's notices tap undo while editing a little. */
  async undoWave(): Promise<void> {
    this.net.faults = true;
    this.trace.push(`t=${this.events.now} --- undo wave (faults on) ---`);
    for (let i = 0; i < this.cfg.undoRounds; i++) {
      this.events.now += this.r.range(1, 15);
      await this.events.runDue();
      await this.settle();
      for (const client of this.clients) {
        if (client.halted) continue;
        const roll = this.r.next();
        if (roll < 0.5) await client.undoTap();
        else if (roll < 0.62) await client.userAction(this.cfg.kinds);
      }
      for (const client of this.clients) await client.tick();
      await this.settle();
      for (const client of this.clients) await checkCursorSafety(this, client);
    }
  }
}
