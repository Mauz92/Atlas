/**
 * The sync engine: a tick-driven state machine over injected ports (SYNC-08).
 *
 * `tick()` starts AT MOST ONE request (queue strictly FIFO, one request in flight per client, hence
 * one per entity) and returns; the reply is handled in the background. Nothing here reads a
 * clock to decide order (D11): the monotonic clock times request deadlines and backoff.
 *
 * Durable (survives a restart, lives in the {@link LocalStore}): the queue with each operation's
 * idempotency key and frozen base, the mirror of server state, drafts, resolution notices, the
 * cursor, the epoch and a halt. Volatile (a restart destroys it, nothing is lost): the request in
 * flight, a half-done pull, timers.
 */

import { backoffDelay, DEFAULT_BACKOFF, parseRetryAfter, type BackoffOptions } from "./backoff.ts";
import {
  applyAck,
  applyDeleteAck,
  applyLive,
  applyTombstone,
  isDeletedPayload,
  newEntity,
  type ApplyOptions,
} from "./entities.ts";
import { merge3 } from "./merge3.ts";
import { checkPortable, normalizeNotePath } from "./portable.ts";
import type {
  Clock,
  Credentials,
  HttpRequest,
  HttpResponse,
  IdGenerator,
  LocalStore,
  Logger,
  Random,
  Sha256,
  StoreTx,
  Transport,
} from "./ports.ts";
import { buildOpRequest } from "./requests.ts";
import type { Halt, StatusListener, SyncState, SyncStatus } from "./status.ts";
import {
  ENTITY_TYPES,
  PLURAL,
  type EntityType,
  type FieldConflict,
  type Json,
  type LocalEntity,
  type NoteDraft,
  type OpAction,
  type Problem,
  type QueueOp,
  type ResolutionRecord,
  type WireChange,
  type WirePage,
} from "./types.ts";
import { materialise, type EntityView } from "./view.ts";

/** Defects the simulation plants to prove each invariant can fail. Never set in production. */
export interface PlantedBugs {
  advanceCursorBeforeApply?: boolean;
  regenKeyOnRetry?: boolean;
  ignoreTombstones?: boolean;
  applyStaleRevisions?: boolean;
  trustAckState?: boolean;
  orderQueueByWallClock?: boolean;
  ignore426?: boolean;
  ignoreRevoked?: boolean;
  /** A retry of a frozen operation takes a fresh base (not byte-identical). */
  rebaseFrozenOps?: boolean;
}

export interface EngineOptions {
  protocol: number;
  pageSize: number;
  requestTimeoutMs: number;
  backoff: BackoffOptions;
  pullIntervalMs: number;
  pullJitterMs: number;
  /** Minimum time between two automatic resyncs (SYNC_PROTOCOL 7.5). */
  resyncMinIntervalMs: number;
  trackResolutions: boolean;
  /** The device id (`GET /api/devices/current`); notices of other devices are "elsewhere". */
  deviceId: string | null;
  plantedBugs: PlantedBugs;
}

export const DEFAULT_OPTIONS: EngineOptions = {
  protocol: 1,
  pageSize: 100,
  requestTimeoutMs: 30_000,
  backoff: DEFAULT_BACKOFF,
  pullIntervalMs: 30_000,
  pullJitterMs: 5_000,
  resyncMinIntervalMs: 600_000,
  trackResolutions: true,
  deviceId: null,
  plantedBugs: {},
};

/** What a host or a test can watch. All callbacks are optional and must not throw. */
export interface EngineObserver {
  /** Every request of a queued operation, as sent (the simulation checks retries are identical). */
  sending?(op: QueueOp, request: HttpRequest): void;
  ack?(op: QueueOp, response: HttpResponse): void;
  refused?(op: QueueOp, response: HttpResponse): void;
  undone?(op: QueueOp, response: HttpResponse): void;
  undoRefused?(op: QueueOp, response: HttpResponse): void;
  halted?(halt: Halt): void;
  pageApplied?(info: { cursor: number; changes: number }): void;
  resynced?(info: { mode: "snapshot" | "restore"; entities: number; cursor: number }): void;
}

export interface EngineDeps {
  store: LocalStore;
  transport: Transport;
  clock: Clock;
  ids: IdGenerator;
  random: Random;
  logger?: Logger;
  credentials?: Credentials;
  sha256?: Sha256;
  observer?: EngineObserver;
  options?: Partial<EngineOptions>;
}

type Kind = "push" | "feed" | "get" | "hydrate" | "epoch";

interface Inflight {
  attempt: number;
  kind: Kind;
  deadline: number;
  detail?: unknown;
}

interface Shadow {
  entities: Map<string, { type: EntityType; data: Record<string, Json> | null; revision: number | null }>;
  resolutions: Map<string, ResolutionRecord>;
  restore: boolean;
}

interface PullJob {
  since: number;
  stage: "feed" | "get";
  page?: WirePage;
  todo: string[];
  fetched: Map<string, Record<string, Json> | null>;
  refetch: string[];
  shadow?: Shadow;
}

export class InvalidPathError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

export class SyncUserError extends Error {}

const WRITABLE: Record<"task" | "project", readonly string[]> = {
  task: [
    "title", "description", "status", "priority", "project_id", "parent_task_id", "start_at",
    "due_at", "time_zone", "duration_minutes", "recurrence_rule", "tags",
  ],
  project: ["name", "description", "status", "start_date", "target_date"],
};

const NOOP_LOGGER: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function asRecord(value: unknown): Record<string, Json> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : null;
}

function errorCode(body: unknown): string | null {
  const record = asRecord(body);
  return record && typeof record["error"] === "string" ? (record["error"] as string) : null;
}

export class SyncEngine {
  private readonly store: LocalStore;
  private readonly transport: Transport;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly random: Random;
  private readonly log: Logger;
  private readonly credentials: Credentials | undefined;
  private readonly sha256: Sha256 | undefined;
  private readonly observer: EngineObserver;
  readonly options: EngineOptions;

  private initDone = false;
  private disposed = false;
  private busyCount = 0;
  private waiters: Array<() => void> = [];
  private halt: Halt | null = null;
  private epoch: string | null = null;
  private inflight: Inflight | null = null;
  private job: PullJob | null = null;
  private attempt = 0;
  private failures = 0;
  private retryAt = 0;
  private nextPullAt = 0;
  private lastResyncAt: number | null = null;
  private offline = false;
  private pullChanged = false;
  private restoreRequested = false;
  private listeners = new Set<StatusListener>();
  private lastStatusJson = "";
  /** Requests sent (for tests: a halted engine must send nothing more). */
  sent = 0;
  /** Consecutive completed pulls that changed nothing (quiescence detection). */
  cleanPulls = 0;

  constructor(deps: EngineDeps) {
    this.store = deps.store;
    this.transport = deps.transport;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.random = deps.random;
    this.log = deps.logger ?? NOOP_LOGGER;
    this.credentials = deps.credentials;
    this.sha256 = deps.sha256;
    this.observer = deps.observer ?? {};
    this.options = { ...DEFAULT_OPTIONS, ...deps.options };
  }

  // --- lifecycle ----------------------------------------------------------------------------

  private get bugs(): PlantedBugs {
    return this.options.plantedBugs;
  }

  private get applyOptions(): ApplyOptions & { trustAck?: boolean | undefined } {
    return {
      sha256: this.sha256,
      applyStale: this.bugs.applyStaleRevisions,
      trustAck: this.bugs.trustAckState,
    };
  }

  private async init(): Promise<void> {
    if (this.initDone) return;
    await this.store.transaction(async (tx) => {
      this.halt = ((await tx.getMeta<Json>("halt")) as unknown as Halt | undefined) ?? null;
      this.epoch = ((await tx.getMeta<string>("epoch")) as string | undefined) ?? null;
    });
    this.initDone = true;
  }

  /** The process is gone (tests): late replies are ignored and nothing more is written. */
  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  // --- the driver ---------------------------------------------------------------------------

  /** Start at most one request. Resolves once it has been issued (not answered). */
  async tick(): Promise<void> {
    if (this.disposed || this.busyCount > 0) return;
    this.enter();
    try {
      await this.init();
      if (this.halt) return;
      const now = this.clock.monotonic();
      if (this.inflight) {
        if (now >= this.inflight.deadline) {
          this.log.warn("request_timeout", { kind: this.inflight.kind });
          this.inflight = null;
          this.offline = true;
          this.failed(null);
        }
        return;
      }
      if (now < this.retryAt) return;
      if (this.job) return await this.jobStep();
      if (now >= this.nextPullAt) {
        await this.startPull();
        return;
      }
      if (await this.background()) return;
      await this.pushNext();
    } catch (error) {
      this.internalError("tick", error);
    } finally {
      this.leave();
      void this.notify();
    }
  }

  private enter(): void {
    this.busyCount++;
  }

  private leave(): void {
    this.busyCount--;
    if (this.busyCount === 0 && this.inflight === null) {
      for (const wake of this.waiters.splice(0)) wake();
    }
  }

  /** Resolves when no handler is running and no request is in flight. */
  settled(): Promise<void> {
    if (this.busyCount === 0 && this.inflight === null) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /**
   * Drive until nothing is left to do or the engine must wait (backoff, halt). For hosts and unit
   * tests whose transport answers; the simulation drives `tick()` itself on virtual time.
   */
  async syncUntilSettled(maxTicks = 500): Promise<void> {
    for (let i = 0; i < maxTicks; i++) {
      await this.tick();
      await this.settled();
      if (this.halt || this.disposed) return;
      if (this.clock.monotonic() < this.retryAt) return;
      if ((await this.isIdle()) && this.cleanPulls >= 1) return;
    }
  }

  async isIdle(): Promise<boolean> {
    if (this.inflight || this.job || this.busyCount > 0) return false;
    return this.store.transaction(async (tx) => {
      if ((await tx.listQueue()).length > 0) return false;
      const unhydrated = (await tx.listEntities()).some(
        (e) => e.type === "note" && !e.deleted && e.server && e.server.content === null,
      );
      return !unhydrated;
    });
  }

  /** Volatile state, for the simulation's invariants. */
  debug(): { halted: Halt | null; cleanPulls: number; sent: number; inflight: boolean; job: boolean } {
    return {
      halted: this.halt,
      cleanPulls: this.cleanPulls,
      sent: this.sent,
      inflight: this.inflight !== null,
      job: this.job !== null,
    };
  }

  /** Force the next tick to pull (focus, network change, test). */
  requestPull(): void {
    this.nextPullAt = 0;
    this.cleanPulls = 0;
  }

  /** The network came back: try at once, once (SYNC_PROTOCOL 8.2). */
  retryNow(): void {
    this.retryAt = 0;
    this.failures = 0;
  }

  private internalError(where: string, error: unknown): void {
    this.log.error("internal_error", {
      where,
      message: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
    this.inflight = null;
    this.job = null;
    this.failed(null);
  }

  private failed(retryAfterMs: number | null): void {
    this.inflight = null;
    this.job = null; // a half-done pull is abandoned; durable state is untouched
    this.failures++;
    const jitter = backoffDelay(this.failures, this.random, this.options.backoff);
    this.retryAt = this.clock.monotonic() + Math.max(jitter, retryAfterMs ?? 0);
  }

  // --- sending ------------------------------------------------------------------------------

  private async send(
    kind: Kind,
    request: Omit<HttpRequest, "headers"> & { headers?: Record<string, string> },
    detail?: unknown,
  ): Promise<void> {
    const headers: Record<string, string> = {
      ...request.headers,
      "Atlas-Sync": String(this.options.protocol),
    };
    const token = this.credentials ? await this.credentials.getToken() : null;
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (this.epoch) headers["Atlas-Epoch"] = this.epoch;
    const attempt = ++this.attempt;
    this.inflight = {
      attempt,
      kind,
      deadline: this.clock.monotonic() + this.options.requestTimeoutMs,
      detail,
    };
    this.sent++;
    const { headers: _ignored, ...rest } = request;
    void _ignored;
    this.transport.send({ ...rest, headers }).then(
      (response) => void this.onReply(attempt, response),
      () => void this.onReply(attempt, null),
    );
  }

  private async onReply(attempt: number, response: HttpResponse | null): Promise<void> {
    if (this.disposed) return;
    const inflight = this.inflight;
    if (!inflight || inflight.attempt !== attempt) {
      this.log.debug("late_reply_ignored", { attempt });
      return;
    }
    this.inflight = null;
    this.enter();
    try {
      await this.handle(inflight, response);
    } catch (error) {
      this.internalError("reply", error);
    } finally {
      this.leave();
      void this.notify();
    }
  }

  private async handle(inflight: Inflight, response: HttpResponse | null): Promise<void> {
    if (response === null) {
      this.log.info("no_response", { kind: inflight.kind });
      this.offline = true;
      this.failed(null);
      return;
    }
    this.offline = false;
    const status = response.status;
    const code = errorCode(response.body);
    if (status === 426 && !this.bugs.ignore426) {
      const body = asRecord(response.body);
      await this.setHalt({
        kind: "update_required",
        min: typeof body?.["min"] === "number" ? (body["min"] as number) : null,
        max: typeof body?.["max"] === "number" ? (body["max"] as number) : null,
      });
      return;
    }
    if (status === 401 && !this.bugs.ignoreRevoked) {
      await this.setHalt({ kind: "signed_out", code: code ?? "unauthenticated" });
      return;
    }
    if (status === 403 && code !== "forbidden_scope" && !this.bugs.ignoreRevoked) {
      await this.setHalt({ kind: "signed_out", code: code ?? "forbidden" });
      return;
    }
    if (status === 409 && code === "epoch_mismatch") {
      const body = asRecord(response.body);
      await this.setHalt({
        kind: "restore_confirmation",
        reason: "epoch_mismatch",
        epoch: typeof body?.["epoch"] === "string" ? (body["epoch"] as string) : null,
        head: null,
      });
      return;
    }
    if (status === 429 || status >= 500) {
      const wait = parseRetryAfter(response.headers["retry-after"], this.clock.wallTime());
      this.log.info("retry_later", { kind: inflight.kind, status });
      this.failed(wait);
      return;
    }
    this.failures = 0;
    switch (inflight.kind) {
      case "push":
        await this.onPush(inflight.detail as QueueOp, response);
        return;
      case "feed":
        await this.onFeed(response);
        return;
      case "get":
        this.onGet(inflight.detail as string, response);
        return;
      case "hydrate":
        await this.onHydrate(inflight.detail as string, response);
        return;
      case "epoch":
        await this.onEpoch(response);
        return;
    }
  }

  private async setHalt(halt: Halt): Promise<void> {
    this.inflight = null;
    this.job = null;
    // durable first: a halt that was not stored must not be believed (the next reply repeats it)
    await this.store.transaction(async (tx) => tx.setMeta("halt", halt as unknown as Json));
    this.halt = halt;
    this.log.warn("halted", { kind: halt.kind });
    this.observer.halted?.(halt);
  }

  // --- push ---------------------------------------------------------------------------------

  private async pushNext(): Promise<void> {
    for (let guard = 0; guard < 50; guard++) {
      const op = await this.store.transaction(async (tx) => {
        const queue = await tx.listQueue();
        if (this.bugs.orderQueueByWallClock) queue.sort((a, b) => a.createdAt - b.createdAt);
        const next = queue[0];
        return next ? this.freeze(tx, next) : null;
      });
      if (op === null) return;
      if (op === "removed") continue;
      const type = op.type;
      const base = buildOpRequest(op, type);
      const key = this.bugs.regenKeyOnRetry && op.attempts > 1 ? this.ids.uuid() : op.key;
      this.log.debug("push", { action: op.action, type, attempts: op.attempts });
      this.observer.sending?.(op, { ...base, headers: { "Idempotency-Key": key } });
      await this.send("push", { ...base, headers: { "Idempotency-Key": key } }, op);
      return;
    }
  }

  /** Fix what a request is made of at its first send, so every retry is byte-identical. */
  private async freeze(tx: StoreTx, op: QueueOp): Promise<QueueOp | "removed"> {
    if (!op.frozen || this.bugs.rebaseFrozenOps) {
      if (op.action === "put") {
        const draft = await tx.getDraft(op.entityId);
        if (!draft || draft.baseRevision === null || draft.text === draft.baseText) {
          await tx.removeOp(op.id);
          if (draft && draft.text === draft.baseText) await tx.removeDraft(op.entityId);
          return "removed";
        }
        op.content = draft.text;
        op.base = draft.baseRevision;
        op.baseHash = draft.baseHash;
        draft.inFlightOp = op.id;
        draft.frozenText = draft.text;
        await tx.putDraft(draft);
      } else if (op.action === "patch" || op.action === "delete" || op.action === "move") {
        op.base = op.chainBase ?? op.userBase;
      }
      op.frozen = true;
    }
    op.attempts++;
    await tx.putOp(op);
    return op;
  }

  private async onPush(sent: QueueOp, response: HttpResponse): Promise<void> {
    const outcome = await this.store.transaction(async (tx) => {
      const queue = await tx.listQueue();
      const op = queue.find((o) => o.id === sent.id);
      if (!op) return null; // already settled
      if (op.action === "undo") return this.settleUndo(tx, op, response);
      if (response.status >= 200 && response.status < 300) {
        await this.ack(tx, op, queue, response);
        return { op, kind: "ack" as const };
      }
      await this.refuse(tx, op, queue, response);
      return { op, kind: "refused" as const };
    });
    if (!outcome) return;
    if (outcome.kind === "ack") this.observer.ack?.(outcome.op, response);
    else if (outcome.kind === "refused") this.observer.refused?.(outcome.op, response);
    else if (outcome.kind === "undone") this.observer.undone?.(outcome.op, response);
    else this.observer.undoRefused?.(outcome.op, response);
  }

  private async ack(
    tx: StoreTx,
    op: QueueOp,
    queue: QueueOp[],
    response: HttpResponse,
  ): Promise<void> {
    await tx.removeOp(op.id);
    const type = op.type as EntityType;
    const body = asRecord(response.body);
    if (op.action === "delete") {
      await applyDeleteAck(tx, type, op.entityId, this.applyOptions);
    } else if (body) {
      await applyAck(tx, type, op.entityId, body, this.applyOptions);
      await this.recordPartialConflicts(tx, op, body);
    }
    const revision = body && typeof body["revision"] === "number" ? (body["revision"] as number) : null;
    // chained bases: a later operation of this entity continues from what this one produced
    let chain: number | null = null;
    if (revision !== null) {
      if (op.action === "create") chain = revision;
      else if (op.base !== null && revision === op.base + 1) chain = revision;
    }
    if (chain !== null) {
      for (const later of queue) {
        if (later.entityId === op.entityId && later.seq > op.seq && !later.frozen) {
          later.chainBase = chain;
          await tx.putOp(later);
        }
      }
    }
    if (type === "note" && (op.action === "put" || op.action === "create")) {
      await this.settleNoteSave(tx, op, body);
    }
  }

  private async recordPartialConflicts(
    tx: StoreTx,
    op: QueueOp,
    body: Record<string, Json>,
  ): Promise<void> {
    const sync = asRecord(body["sync"]);
    const conflicts = Array.isArray(sync?.["conflicts"]) ? (sync["conflicts"] as Json[]) : [];
    if (conflicts.length === 0) return;
    await tx.putProblem(
      this.problem(op, "conflict", 200, "partial_conflict", {
        conflicts: conflicts.map((c) => this.fieldConflict(op, asRecord(c) ?? {})),
      }),
    );
  }

  private fieldConflict(op: QueueOp, c: Record<string, Json>): FieldConflict {
    const field = String(c["field"] ?? "");
    return {
      field,
      reason: String(c["reason"] ?? "text_conflict"),
      serverRevision: typeof c["server_revision"] === "number" ? (c["server_revision"] as number) : null,
      theirs: c["server_value"] ?? null,
      mine: op.fields[field] ?? null,
    };
  }

  private problem(
    op: QueueOp,
    kind: Problem["kind"],
    status: number | null,
    code: string | null,
    extra: Partial<Problem> = {},
  ): Problem {
    return {
      id: this.ids.uuid(),
      kind,
      reason: code ?? "refused",
      status,
      code,
      opId: op.id,
      action: op.action,
      entityType: op.type,
      entityId: op.entityId,
      at: this.clock.wallTime(),
      detail: null,
      conflicts: [],
      mineText: null,
      mineLatestText: null,
      copy: null,
      ...extra,
    };
  }

  private async refuse(
    tx: StoreTx,
    op: QueueOp,
    queue: QueueOp[],
    response: HttpResponse,
  ): Promise<void> {
    const body = asRecord(response.body);
    const code = errorCode(response.body);
    await tx.removeOp(op.id);
    // later operations of this entity lose the chained base this one would have produced
    for (const later of queue) {
      if (later.entityId === op.entityId && later.seq > op.seq && later.chainBase !== null) {
        later.chainBase = null;
        await tx.putOp(later);
      }
    }
    const isConflict =
      response.status === 409 &&
      (code === "conflict" || code === "edit_wins" || code === "path_exists" || code === "note_deleted");
    const conflicts = Array.isArray(body?.["conflicts"])
      ? (body["conflicts"] as Json[]).map((c) => this.fieldConflict(op, asRecord(c) ?? {}))
      : [];
    const copy = asRecord(body?.["conflict_copy"]);
    const draft = op.type === "note" ? await tx.getDraft(op.entityId) : undefined;
    const problem = this.problem(op, isConflict ? "conflict" : "failed", response.status, code, {
      detail: typeof body?.["detail"] === "string" ? (body["detail"] as string).slice(0, 300) : null,
      conflicts,
      copy: copy
        ? {
            id: String(copy["id"]),
            path: String(copy["path"]),
            revision: Number(copy["revision"]),
            content_hash: String(copy["content_hash"]),
          }
        : null,
    });
    if (op.action === "put" || (op.action === "create" && op.type === "note")) {
      const sentText = op.action === "put" ? op.content : (op.fields["content"] as string | undefined) ?? null;
      problem.mineText = sentText ?? null;
      if (draft && draft.text !== sentText) problem.mineLatestText = draft.text;
      if (op.action === "put") await tx.removeDraft(op.entityId);
      else if (draft) await tx.removeDraft(op.entityId);
    }
    await tx.putProblem(problem);
    const existing = await tx.getEntity(op.entityId);
    const keepsEntity = op.action !== "create" && response.status !== 404 && existing?.server;
    if (existing && keepsEntity) {
      existing.refetch = true;
      await tx.putEntity(existing);
    } else if (op.action === "create" && existing && !existing.server && !existing.deleted) {
      // a create the server refused: the entity never existed there
      const remaining = queue.filter((o) => o.entityId === op.entityId && o.id !== op.id);
      if (remaining.length === 0) await tx.removeEntity(op.entityId);
    }
    this.log.info("op_refused", { action: op.action, status: response.status, code });
  }

  // --- undo ---------------------------------------------------------------------------------

  private async settleUndo(
    tx: StoreTx,
    op: QueueOp,
    response: HttpResponse,
  ): Promise<{ op: QueueOp; kind: "undone" | "undoRefused" }> {
    await tx.removeOp(op.id);
    const body = asRecord(response.body);
    if (response.status >= 200 && response.status < 300 && body) {
      for (const key of ["resolution", "undo"]) {
        const record = asRecord(body[key]);
        if (record?.["id"]) await this.putResolutionByState(tx, record as unknown as ResolutionRecord);
      }
      const ref = asRecord(body["resolution"]);
      if (ref && typeof ref["entity_id"] === "string") {
        const entity = await tx.getEntity(ref["entity_id"] as string);
        if (entity) {
          entity.refetch = true; // an answer is historical: read the entity again
          await tx.putEntity(entity);
        }
      }
      return { op, kind: "undone" };
    }
    const resolution = asRecord(body?.["resolution"]);
    if (resolution?.["id"] && !Array.isArray(resolution)) {
      await this.putResolutionByState(tx, resolution as unknown as ResolutionRecord);
    }
    await tx.putProblem(
      this.problem(op, "conflict", response.status, errorCode(response.body), {
        detail: typeof body?.["detail"] === "string" ? (body["detail"] as string).slice(0, 300) : null,
      }),
    );
    return { op, kind: "undoRefused" };
  }

  private async putResolutionByState(tx: StoreTx, record: ResolutionRecord): Promise<void> {
    const held = (await tx.listResolutions()).find((r) => r.id === record.id);
    const state = (r: ResolutionRecord) => (r.undone_at ? 2 : 1);
    if (!held || state(record) >= state(held)) await tx.putResolution(record);
  }

  // --- notes: a save's answer rebases the text typed since --------------------------------------

  private async settleNoteSave(
    tx: StoreTx,
    op: QueueOp,
    body: Record<string, Json> | null,
  ): Promise<void> {
    const draft = await tx.getDraft(op.entityId);
    if (!draft || draft.inFlightOp !== op.id) return;
    const sent = draft.frozenText ?? "";
    if (draft.text === sent) {
      await tx.removeDraft(op.entityId);
      return;
    }
    const merged = typeof body?.["content"] === "string" ? (body["content"] as string) : null;
    const revision = typeof body?.["revision"] === "number" ? (body["revision"] as number) : null;
    const hash = typeof body?.["content_hash"] === "string" ? (body["content_hash"] as string) : null;
    if (merged === null || revision === null || hash === null) {
      // the answer carries no text (a replay of a pruned revision): read the note, then rebase
      draft.inFlightOp = null;
      draft.baseRevision = null;
      draft.baseHash = null;
      draft.baseText = null;
      draft.rebaseFrom = sent;
      await tx.putDraft(draft);
      const entity = await tx.getEntity(op.entityId);
      if (entity) {
        entity.refetch = true;
        await tx.putEntity(entity);
      }
      return;
    }
    await this.rebaseDraft(tx, draft, sent, { revision, hash, text: merged });
  }

  /** `draft.text` derives from `sent`; the server now holds `base`: carry the edits across. */
  private async rebaseDraft(
    tx: StoreTx,
    draft: NoteDraft,
    sent: string,
    base: { revision: number; hash: string; text: string },
  ): Promise<void> {
    let text = draft.text;
    if (base.text !== sent) {
      const result = merge3(sent, base.text, draft.text);
      if (result.text === null) {
        // Not combinable: keep what was typed as data, show the server's text. Nothing is lost.
        await tx.putProblem({
          id: this.ids.uuid(),
          kind: "conflict",
          reason: `rebase_${result.reason ?? "overlap"}`,
          status: null,
          code: null,
          opId: draft.inFlightOp ?? "",
          action: "put",
          entityType: "note",
          entityId: draft.entityId,
          at: this.clock.wallTime(),
          detail: null,
          conflicts: [],
          mineText: null,
          mineLatestText: draft.text,
          copy: null,
        });
        await tx.removeDraft(draft.entityId);
        return;
      }
      text = result.text;
    }
    if (text === base.text) {
      await tx.removeDraft(draft.entityId);
      return;
    }
    draft.text = text;
    draft.baseRevision = base.revision;
    draft.baseHash = base.hash;
    draft.baseText = base.text;
    draft.inFlightOp = null;
    draft.frozenText = null;
    draft.rebaseFrom = null;
    await tx.putDraft(draft);
    await this.enqueue(tx, {
      type: "note",
      action: "put",
      entityId: draft.entityId,
      fields: {},
      userBase: base.revision,
    });
  }

  // --- pull ---------------------------------------------------------------------------------

  private async startPull(): Promise<void> {
    const cursor = await this.store.transaction(async (tx) => (await tx.getMeta<number>("cursor")) ?? 0);
    this.job = { since: cursor, stage: "feed", todo: [], fetched: new Map(), refetch: [] };
    this.pullChanged = false;
    if (this.epoch === null) {
      await this.send("epoch", { method: "GET", path: "/api/instance" });
      return;
    }
    await this.jobStep();
  }

  private async onEpoch(response: HttpResponse): Promise<void> {
    const body = asRecord(response.body);
    const sync = asRecord(body?.["sync"]);
    const epoch = typeof sync?.["epoch"] === "string" ? (sync["epoch"] as string) : null;
    if (response.status === 200 && epoch) {
      this.epoch = epoch;
      await this.store.transaction(async (tx) => tx.setMeta("epoch", epoch));
    } else {
      // an instance without epoch support: carry on without the header, ask again next pull
      this.log.info("epoch_unknown", { status: response.status });
      this.epoch = null;
    }
    await this.jobStep();
  }

  private async jobStep(): Promise<void> {
    const job = this.job;
    if (!job) return;
    if (job.stage === "feed") {
      const query: Record<string, string | number | boolean> = {
        since: job.since,
        limit: this.options.pageSize,
        include: "data",
        types: this.options.trackResolutions ? "task,project,note,resolution" : "task,project,note",
      };
      if (job.shadow && job.since > 0) query["snapshot"] = true; // a continuation of a snapshot walk
      await this.send("feed", { method: "GET", path: "/api/changes", query });
    } else if (job.todo.length > 0) {
      const id = job.todo[0]!;
      const type = await this.store.transaction(async (tx) => (await tx.getEntity(id))?.type);
      if (!type) {
        job.todo.shift();
        return this.jobStep();
      }
      await this.send("get", { method: "GET", path: `/api/${PLURAL[type]}/${id}` }, id);
    } else {
      await this.commitPage(job);
    }
  }

  private async onFeed(response: HttpResponse): Promise<void> {
    const job = this.job;
    if (!job || response.status !== 200) {
      this.log.warn("feed_failed", { status: response.status });
      this.failed(null);
      return;
    }
    const page = response.body as WirePage;
    if (page.resync_required) {
      await this.onResyncRequired(page);
      return;
    }
    job.page = page;
    if (this.bugs.advanceCursorBeforeApply) {
      await this.store.transaction(async (tx) => tx.setMeta("cursor", page.next_since));
    }
    const inPage = new Set(page.changes.map((c) => c.entity_id));
    const refetch = await this.store.transaction(async (tx) =>
      (await tx.listEntities()).filter((e) => e.refetch && !inPage.has(e.id)).map((e) => e.id).sort(),
    );
    job.refetch = refetch;
    job.todo = [...refetch];
    job.stage = "get";
    await this.jobStep();
  }

  private async onResyncRequired(page: WirePage): Promise<void> {
    const reason = page.resync_reason ?? "unknown";
    this.log.warn("resync_required", { reason });
    if (reason === "cursor_ahead" && !this.restoreRequested) {
      // The server holds less than we have seen (restored from a backup): never automatic (D12).
      await this.setHalt({
        kind: "restore_confirmation",
        reason: "cursor_ahead",
        epoch: null,
        head: page.next_since,
      });
      return;
    }
    const now = this.clock.monotonic();
    const throttled =
      !this.restoreRequested &&
      this.lastResyncAt !== null &&
      now - this.lastResyncAt < this.options.resyncMinIntervalMs;
    if (throttled) {
      // storm control (SYNC_PROTOCOL 7.5): do not resync again within the interval
      this.job = null;
      this.nextPullAt = this.lastResyncAt! + this.options.resyncMinIntervalMs;
      return;
    }
    this.lastResyncAt = now;
    this.job = {
      since: 0,
      stage: "feed",
      todo: [],
      fetched: new Map(),
      refetch: [],
      shadow: {
        entities: new Map(),
        resolutions: new Map(),
        restore: this.restoreRequested,
      },
    };
    await this.jobStep();
  }

  private onGet(id: string, response: HttpResponse): void {
    const job = this.job;
    if (!job) return;
    if (response.status === 200) job.fetched.set(id, asRecord(response.body));
    else if (response.status === 404) job.fetched.set(id, null);
    else {
      this.failed(null);
      return;
    }
    job.todo.shift();
  }

  private async commitPage(job: PullJob): Promise<void> {
    const page = job.page;
    if (!page) return;
    if (job.shadow) {
      await this.shadowPage(job, page);
      return;
    }
    let changed = false;
    await this.store.transaction(async (tx) => {
      const refreshed = new Set(job.refetch);
      for (const id of job.refetch) {
        const entity = await tx.getEntity(id);
        if (!entity) continue;
        const body = job.fetched.get(id) ?? null;
        if (body === null) changed = (await applyTombstone(tx, entity.type, id, null, this.applyOptions)) || changed;
        else changed = (await applyLive(tx, entity.type, id, body, this.applyOptions)) || changed;
        const after = await tx.getEntity(id);
        if (after) {
          after.refetch = false;
          await tx.putEntity(after);
        }
      }
      for (const change of page.changes) {
        if (change.entity_type === "resolution") {
          if (change.data) {
            await this.putResolutionByState(tx, change.data as unknown as ResolutionRecord);
            changed = true;
          }
          continue;
        }
        const type = change.entity_type as EntityType;
        if (!ENTITY_TYPES.includes(type)) continue;
        if (refreshed.has(change.entity_id)) continue; // the re-read above is newer than this row
        const data = change.data ?? null;
        if (change.operation === "delete" || isDeletedPayload(data)) {
          if (this.bugs.ignoreTombstones) continue;
          const revision = this.revisionOf(change, data);
          changed = (await applyTombstone(tx, type, change.entity_id, revision, this.applyOptions)) || changed;
        } else {
          changed = (await applyLive(tx, type, change.entity_id, data!, this.applyOptions)) || changed;
        }
        const entity = await tx.getEntity(change.entity_id);
        if (entity?.refetch) {
          entity.refetch = false; // the row was read after our acknowledged write
          await tx.putEntity(entity);
        }
      }
      await this.rebasePending(tx);
      await tx.setMeta("cursor", page.next_since);
      if (!page.has_more) await tx.setMeta("lastSyncAt", this.clock.wallTime());
    });
    changed = changed || page.changes.length > 0;
    this.pullChanged ||= changed;
    this.observer.pageApplied?.({ cursor: page.next_since, changes: page.changes.length });
    this.finishPage(page.has_more, page.next_since);
  }

  private revisionOf(change: WireChange, data: Record<string, Json> | null): number | null {
    if (typeof change.revision === "number") return change.revision;
    if (data && typeof data["revision"] === "number") return data["revision"] as number;
    return null;
  }

  private finishPage(hasMore: boolean, cursor: number): void {
    if (hasMore) {
      this.job = { since: cursor, stage: "feed", todo: [], fetched: new Map(), refetch: [] };
      return;
    }
    this.job = null;
    this.nextPullAt =
      this.clock.monotonic() + this.options.pullIntervalMs + Math.floor(this.random.next() * this.options.pullJitterMs);
    this.cleanPulls = this.pullChanged ? 0 : this.cleanPulls + 1;
  }

  /** An unsent patch whose fields nobody changed since its base continues from the new revision. */
  private async rebasePending(tx: StoreTx): Promise<void> {
    for (const op of await tx.listQueue()) {
      if (op.action !== "patch" || op.frozen || op.chainBase !== null || op.userBase === null) continue;
      const entity = await tx.getEntity(op.entityId);
      const server = entity?.server;
      if (!entity || !server || entity.deleted || server.revision <= op.userBase) continue;
      const untouched = Object.keys(op.fields).every((field) => {
        const stamp = server.fieldRevisions[field];
        return stamp !== undefined && stamp <= op.userBase!;
      });
      if (untouched) {
        op.userBase = server.revision;
        await tx.putOp(op);
      }
    }
  }

  // --- snapshot / resync ----------------------------------------------------------------------

  private async shadowPage(job: PullJob, page: WirePage): Promise<void> {
    const shadow = job.shadow!;
    for (const change of page.changes) {
      if (change.entity_type === "resolution") {
        if (change.data) shadow.resolutions.set(change.entity_id, change.data as unknown as ResolutionRecord);
        continue;
      }
      const type = change.entity_type as EntityType;
      if (!ENTITY_TYPES.includes(type)) continue;
      const data = change.data ?? null;
      if (change.operation === "delete" || isDeletedPayload(data)) {
        shadow.entities.set(change.entity_id, { type, data: null, revision: this.revisionOf(change, data) });
      } else {
        shadow.entities.set(change.entity_id, { type, data, revision: null });
      }
    }
    if (page.has_more) {
      this.job = { since: page.next_since, stage: "feed", todo: [], fetched: new Map(), refetch: [], shadow };
      return;
    }
    const restore = shadow.restore;
    let lost = 0;
    await this.store.transaction(async (tx) => {
      lost = await this.commitShadow(tx, shadow, restore);
      await tx.setMeta("cursor", page.next_since);
    });
    this.log.info("snapshot_applied", { entities: shadow.entities.size, lost });
    this.observer.resynced?.({
      mode: restore ? "restore" : "snapshot",
      entities: shadow.entities.size,
      cursor: page.next_since,
    });
    this.restoreRequested = false;
    this.job = null;
    this.pullChanged = true;
    this.cleanPulls = 0;
    this.nextPullAt = this.clock.monotonic();
  }

  private async commitShadow(tx: StoreTx, shadow: Shadow, restore: boolean): Promise<number> {
    const queue = await tx.listQueue();
    for (const [id, item] of shadow.entities) {
      if (item.data === null) {
        // Remember the tombstone even for an id never held: a create of it may still be in flight
        // and its acknowledgement must not bring the entity back (seed 681).
        await applyTombstone(tx, item.type, id, item.revision, this.applyOptions);
      } else if (restore) {
        // the restored server is the truth, also where its revision is lower than ours
        const entity = (await tx.getEntity(id)) ?? newEntity(id, item.type);
        entity.deleted = false;
        entity.deletedRevision = null;
        await tx.putEntity(entity);
        await applyLive(tx, item.type, id, item.data, { ...this.applyOptions, applyStale: true });
      } else {
        await applyLive(tx, item.type, id, item.data, this.applyOptions);
      }
    }
    let lost = 0;
    for (const entity of await tx.listEntities()) {
      const inSnapshot = shadow.entities.has(entity.id);
      entity.refetch = false;
      if (entity.deleted || !entity.server) {
        await tx.putEntity(entity);
        continue;
      }
      if (restore) {
        const held = shadow.entities.get(entity.id);
        const behind = held?.data ? Number(held.data["revision"]) < entity.server.revision : true;
        if (!held?.data && !held) {
          lost++;
          await this.recreateLost(tx, entity, queue);
          continue;
        }
        if (held?.data && behind) {
          // the server lost revisions of this entity; the snapshot state is already applied
          lost++;
        }
      } else if (!inSnapshot) {
        // Absent from the snapshot: deleted while we were away. Recorded even while an edit or a delete
        // of it is pending, exactly as the feed path records a tombstone (the cursor is about to move
        // past it, so the store must know); the view lets a pending edit revive it (edit wins), and the
        // queued write is answered by the server as usual.
        entity.deleted = true;
        entity.deletedRevision = null;
      }
      await tx.putEntity(entity);
    }
    await tx.clearResolutions();
    for (const record of shadow.resolutions.values()) await tx.putResolution(record);
    return lost;
  }

  /** SYNC_PROTOCOL 7.4: re-create what the restored server lost, with the same ids. */
  private async recreateLost(tx: StoreTx, entity: LocalEntity, queue: QueueOp[]): Promise<void> {
    const server = entity.server!;
    let fields: Record<string, Json> = {};
    if (entity.type === "note") {
      if (server.content === null) {
        await tx.putProblem({
          id: this.ids.uuid(), kind: "failed", reason: "lost_on_restore", status: null, code: null,
          opId: "", action: "create", entityType: "note", entityId: entity.id,
          at: this.clock.wallTime(), detail: null, conflicts: [], mineText: null,
          mineLatestText: null, copy: null,
        });
        entity.server = null;
        await tx.putEntity(entity);
        return;
      }
      fields = { path: server.fields["path"] ?? null, content: server.content };
    } else {
      for (const name of WRITABLE[entity.type]) {
        if (name in server.fields) fields[name] = server.fields[name]!;
      }
    }
    entity.server = null;
    entity.refetch = false;
    await tx.putEntity(entity);
    const first = queue[0]?.seq ?? (await this.nextSeq(tx));
    const create: QueueOp = this.makeOp({
      type: entity.type, action: "create", entityId: entity.id, fields, userBase: null,
    }, first - 1);
    await tx.putOp(create);
    for (const op of queue) {
      if (op.entityId !== entity.id) continue;
      op.userBase = op.action === "put" ? null : 1;
      op.chainBase = null;
      op.frozen = false;
      op.base = null;
      await tx.putOp(op);
    }
  }

  /** The user confirmed that the server was restored (D12): adopt it and re-create what it lost. */
  async confirmRestore(): Promise<void> {
    await this.init();
    const halt = this.halt;
    if (!halt || halt.kind !== "restore_confirmation") throw new SyncUserError("no restore to confirm");
    if (halt.epoch) {
      this.epoch = halt.epoch;
      await this.store.transaction(async (tx) => tx.setMeta("epoch", halt.epoch as string));
    }
    this.halt = null;
    this.restoreRequested = true;
    this.lastResyncAt = null;
    this.failures = 0;
    this.retryAt = 0;
    await this.store.transaction(async (tx) => tx.removeMeta("halt"));
    // a snapshot walk from 0 is the next pull; the resync_required answer is not needed for it
    this.job = {
      since: 0,
      stage: "feed",
      todo: [],
      fetched: new Map(),
      refetch: [],
      shadow: { entities: new Map(), resolutions: new Map(), restore: true },
    };
    this.lastResyncAt = this.clock.monotonic();
    void this.notify();
  }

  /** The person signed in again (a new token is supplied by the credentials port). */
  async resumeAfterSignIn(): Promise<void> {
    await this.clearHalt("signed_out");
  }

  /** The app was updated to a supported protocol. */
  async resumeAfterUpdate(protocol?: number): Promise<void> {
    if (protocol !== undefined) this.options.protocol = protocol;
    await this.clearHalt("update_required");
  }

  private async clearHalt(kind: Halt["kind"]): Promise<void> {
    await this.init();
    if (this.halt?.kind !== kind) return;
    this.halt = null;
    this.failures = 0;
    this.retryAt = 0;
    await this.store.transaction(async (tx) => tx.removeMeta("halt"));
    void this.notify();
  }

  // --- hydration of note text -----------------------------------------------------------------

  private async background(): Promise<boolean> {
    const id = await this.store.transaction(async (tx) => {
      const wanted = (await tx.listEntities())
        .filter((e) => e.type === "note" && !e.deleted && e.server && e.server.content === null)
        .map((e) => e.id)
        .sort();
      return wanted[0];
    });
    if (!id) return false;
    await this.send("hydrate", { method: "GET", path: `/api/notes/${id}` }, id);
    return true;
  }

  private async onHydrate(id: string, response: HttpResponse): Promise<void> {
    await this.store.transaction(async (tx) => {
      if (response.status === 200) {
        const body = asRecord(response.body);
        if (body) await applyLive(tx, "note", id, body, this.applyOptions);
        const draft = await tx.getDraft(id);
        if (draft?.rebaseFrom != null && typeof body?.["content"] === "string") {
          await this.rebaseDraft(tx, draft, draft.rebaseFrom, {
            revision: Number(body["revision"]),
            hash: String(body["content_hash"]),
            text: body["content"] as string,
          });
        }
      } else if (response.status === 404) {
        await applyTombstone(tx, "note", id, null, this.applyOptions);
      } else {
        this.failed(null);
      }
    });
  }

  // --- user actions ---------------------------------------------------------------------------

  private async nextSeq(tx: StoreTx): Promise<number> {
    const seq = ((await tx.getMeta<number>("seq")) ?? 0) + 1;
    await tx.setMeta("seq", seq);
    return seq;
  }

  private makeOp(
    input: {
      type: QueueOp["type"];
      action: OpAction;
      entityId: string;
      fields: Record<string, Json>;
      userBase: number | null;
    },
    seq: number,
  ): QueueOp {
    return {
      id: this.ids.uuid(),
      seq,
      key: this.ids.uuid(),
      type: input.type,
      action: input.action,
      entityId: input.entityId,
      fields: input.fields,
      userBase: input.userBase,
      chainBase: null,
      base: null,
      baseHash: null,
      content: null,
      frozen: false,
      attempts: 0,
      createdAt: this.clock.wallTime(),
    };
  }

  private async enqueue(
    tx: StoreTx,
    input: Parameters<SyncEngine["makeOp"]>[0],
  ): Promise<QueueOp> {
    const op = this.makeOp(input, await this.nextSeq(tx));
    await tx.putOp(op);
    return op;
  }

  private async user<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    await this.init();
    try {
      return await this.store.transaction(fn);
    } finally {
      void this.notify();
    }
  }

  /** Create a task or project. The id is chosen here, so the entity is addressable at once. */
  async createEntity(
    type: "task" | "project",
    fields: Record<string, Json>,
    id: string = this.ids.uuid(),
  ): Promise<string> {
    return this.user(async (tx) => {
      await tx.putEntity(newEntity(id, type));
      await this.enqueue(tx, { type, action: "create", entityId: id, fields: { ...fields }, userBase: null });
      return id;
    });
  }

  /** Change fields of a task or project. Several edits to one entity coalesce into one request. */
  async updateEntity(
    type: "task" | "project",
    id: string,
    changes: Record<string, Json>,
  ): Promise<void> {
    await this.user(async (tx) => {
      const entity = await this.requireLive(tx, id, type);
      const ops = (await tx.listQueue()).filter((o) => o.entityId === id);
      const create = ops.find((o) => o.action === "create" && !o.frozen);
      if (create) {
        create.fields = { ...create.fields, ...changes };
        await tx.putOp(create);
        return;
      }
      const last = ops[ops.length - 1];
      if (last && last.action === "patch" && !last.frozen) {
        last.fields = { ...last.fields, ...changes }; // keeps the base of the first edit
        await tx.putOp(last);
        return;
      }
      await this.enqueue(tx, {
        type, action: "patch", entityId: id, fields: { ...changes },
        userBase: entity.server?.revision ?? 1,
      });
    });
  }

  private async requireLive(tx: StoreTx, id: string, type: EntityType): Promise<LocalEntity> {
    const entity = await tx.getEntity(id);
    if (!entity || entity.type !== type) throw new SyncUserError(`unknown ${type} ${id}`);
    const ops = (await tx.listQueue()).filter((o) => o.entityId === id);
    // the same view the user sees: a pending edit brings a deleted entity back (edit wins)
    if (materialise(entity, ops, undefined).deleted) throw new SyncUserError(`${type} ${id} is deleted`);
    return entity;
  }

  /** Delete a task, project or note. A create that never left the device just disappears. */
  async deleteEntity(type: EntityType, id: string): Promise<void> {
    await this.user(async (tx) => {
      const entity = await this.requireLive(tx, id, type);
      const ops = (await tx.listQueue()).filter((o) => o.entityId === id);
      const create = ops.find((o) => o.action === "create");
      if (create && !create.frozen) {
        for (const op of ops) await tx.removeOp(op.id);
        await tx.removeEntity(id);
        await tx.removeDraft(id);
        return;
      }
      for (const op of ops) {
        if (!op.frozen && (op.action === "patch" || op.action === "put" || op.action === "move"))
          await tx.removeOp(op.id);
      }
      if (type === "note") await tx.removeDraft(id);
      await this.enqueue(tx, {
        type, action: "delete", entityId: id, fields: {}, userBase: entity.server?.revision ?? 1,
      });
    });
  }

  /** Bring a deleted task back (`POST /api/tasks/{id}/restore`). */
  async restoreTask(id: string): Promise<void> {
    await this.user(async (tx) => {
      const entity = await tx.getEntity(id);
      if (!entity || entity.type !== "task") throw new SyncUserError(`unknown task ${id}`);
      const ops = (await tx.listQueue()).filter((o) => o.entityId === id);
      const last = ops[ops.length - 1];
      if (last?.action === "delete" && !last.frozen) {
        await tx.removeOp(last.id); // delete and restore cancel out before anything was sent
        return;
      }
      if (!entity.deleted && last?.action !== "delete") throw new SyncUserError("task is not deleted");
      await this.enqueue(tx, { type: "task", action: "restore", entityId: id, fields: {}, userBase: null });
    });
  }

  /** Ask the server to undo an automatic resolution (SYNC_PROTOCOL 9). */
  async undoResolution(resolutionId: string): Promise<void> {
    await this.user(async (tx) => {
      const queue = await tx.listQueue();
      if (queue.some((o) => o.action === "undo" && o.entityId === resolutionId)) return;
      // a tap on a notice is not part of the edit stream: it goes in front of unsent operations
      const first = queue.find((o) => !o.frozen);
      const op = this.makeOp(
        { type: "resolution", action: "undo", entityId: resolutionId, fields: {}, userBase: null },
        first ? first.seq - 0.5 : await this.nextSeq(tx),
      );
      await tx.putOp(op);
    });
  }

  // notes

  async createNote(path: string, content: string, id: string = this.ids.uuid()): Promise<string> {
    const normalized = normalizeNotePath(path);
    const problem = checkPortable(normalized);
    if (problem) throw new InvalidPathError(problem.reason, problem.detail);
    return this.user(async (tx) => {
      await tx.putEntity(newEntity(id, "note"));
      await this.enqueue(tx, {
        type: "note", action: "create", entityId: id, fields: { path: normalized, content }, userBase: null,
      });
      return id;
    });
  }

  /** Replace a note's text. Edits while a save is in flight are rebased onto its answer. */
  async editNote(id: string, text: string): Promise<void> {
    await this.user(async (tx) => {
      const entity = await this.requireLive(tx, id, "note");
      const ops = (await tx.listQueue()).filter((o) => o.entityId === id);
      const create = ops.find((o) => o.action === "create");
      let draft = await tx.getDraft(id);
      if (create && !create.frozen) {
        create.fields = { ...create.fields, content: text };
        await tx.putOp(create);
        return;
      }
      if (create && create.frozen) {
        draft ??= {
          entityId: id, text, baseRevision: null, baseHash: null, baseText: null,
          inFlightOp: create.id, frozenText: String(create.fields["content"] ?? ""), rebaseFrom: null,
        };
        draft.text = text;
        await tx.putDraft(draft);
        return;
      }
      if (!draft) {
        const server = entity.server;
        if (!server || server.content === null || server.contentHash === null)
          throw new SyncUserError("the note's text has not been downloaded yet");
        draft = {
          entityId: id, text, baseRevision: server.revision, baseHash: server.contentHash,
          baseText: server.content, inFlightOp: null, frozenText: null, rebaseFrom: null,
        };
      }
      draft.text = text;
      await tx.putDraft(draft);
      if (!ops.some((o) => o.action === "put") && draft.rebaseFrom === null && draft.baseRevision !== null) {
        await this.enqueue(tx, {
          type: "note", action: "put", entityId: id, fields: {}, userBase: draft.baseRevision,
        });
      }
    });
  }

  async moveNote(id: string, path: string): Promise<void> {
    const normalized = normalizeNotePath(path);
    const problem = checkPortable(normalized);
    if (problem) throw new InvalidPathError(problem.reason, problem.detail);
    await this.user(async (tx) => {
      const entity = await this.requireLive(tx, id, "note");
      const ops = (await tx.listQueue()).filter((o) => o.entityId === id);
      const unsent = ops.filter((o) => !o.frozen && (o.action === "create" || o.action === "move"));
      const last = unsent[unsent.length - 1];
      if (last && ops[ops.length - 1] === last) {
        last.fields = { ...last.fields, path: normalized };
        await tx.putOp(last);
        return;
      }
      await this.enqueue(tx, {
        type: "note", action: "move", entityId: id, fields: { path: normalized },
        userBase: entity.server?.revision ?? 1,
      });
    });
  }

  // --- reading --------------------------------------------------------------------------------

  /** The user's view of everything (server state plus pending operations). */
  async views(): Promise<EntityView[]> {
    return this.store.transaction(async (tx) => {
      const queue = await tx.listQueue();
      const out: EntityView[] = [];
      for (const entity of await tx.listEntities()) {
        out.push(materialise(entity, queue, await tx.getDraft(entity.id)));
      }
      return out;
    });
  }

  async view(id: string): Promise<EntityView | undefined> {
    return (await this.views()).find((v) => v.id === id);
  }

  async problems(): Promise<Problem[]> {
    return this.store.transaction(async (tx) => tx.listProblems());
  }

  async dismissProblem(id: string): Promise<void> {
    await this.store.transaction(async (tx) => tx.removeProblem(id));
    void this.notify();
  }

  /** Every resolution notice held, in the order they were learned. */
  async resolutions(): Promise<ResolutionRecord[]> {
    return this.store.transaction(async (tx) => tx.listResolutions());
  }

  /** "Changed on another device": resolutions this device did not make. */
  async notices(): Promise<ResolutionRecord[]> {
    const own = this.options.deviceId;
    return (await this.store.transaction(async (tx) => tx.listResolutions())).filter(
      (r) => r.device_id !== own && r.rule !== "undo",
    );
  }

  setDeviceId(id: string | null): void {
    this.options.deviceId = id;
  }

  // --- status ---------------------------------------------------------------------------------

  async getStatus(): Promise<SyncStatus> {
    await this.init();
    const { pending, failed, conflicts, lastSyncAt, cursor } = await this.store.transaction(async (tx) => {
      const problems = await tx.listProblems();
      return {
        pending: (await tx.listQueue()).length,
        failed: problems.filter((p) => p.kind === "failed").length,
        conflicts: problems.filter((p) => p.kind === "conflict").length,
        lastSyncAt: (await tx.getMeta<number>("lastSyncAt")) ?? null,
        cursor: (await tx.getMeta<number>("cursor")) ?? 0,
      };
    });
    const waiting = this.clock.monotonic() < this.retryAt;
    let state: SyncState = "idle";
    if (this.halt) state = this.halt.kind;
    else if (this.offline) state = "offline";
    else if (waiting && this.failures > 0) state = "backoff";
    else if (this.inflight || this.job) state = "syncing";
    return {
      state, halt: this.halt, pending, failed, conflicts, lastSyncAt,
      online: !this.offline, cursor, failures: this.failures,
      retryAt: waiting ? this.retryAt : null,
    };
  }

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener);
    void this.notify();
    return () => this.listeners.delete(listener);
  }

  private async notify(): Promise<void> {
    if (this.listeners.size === 0 || this.disposed) return;
    let status: SyncStatus;
    try {
      status = await this.getStatus();
    } catch {
      return; // a status read must never break syncing
    }
    const json = JSON.stringify(status);
    if (json === this.lastStatusJson) return;
    this.lastStatusJson = json;
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch {
        // a listener must not break syncing
      }
    }
  }
}
