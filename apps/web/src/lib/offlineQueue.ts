/**
 * Durable, versioned offline mutation queue (M7-03).
 *
 * A user editing while offline (or before a request lands) records a *queued operation* here. Each
 * operation captures everything needed to replay it safely once the connection returns (AGENTS.md
 * §9/§11, `ARCHITECTURE.md` §7):
 *
 * - the entity it targets (`entityType` + `entityId`),
 * - the mutation (`create` | `update` | `delete`),
 * - a client-generated **idempotency key**, so a replayed request can never create a duplicate,
 * - the **`base_revision`** the edit was based on, so a stale write is rejected rather than applied.
 *
 * Operations are held in **FIFO order** (`seq`) and the whole queue is persisted, versioned, through a
 * {@link KeyValueStore}. Because the store is durable, a queued edit survives a page reload — the
 * queue is a client cache only and never the authoritative copy (the server always is).
 *
 * The replayed request mapping and the sync loop live in `syncEngine.ts`, keep business logic out of
 * components, and this module knows nothing about HTTP.
 */

import { getSharedDurableStore, type KeyValueStore } from "./queueStorage";

/** Structured entities an offline edit can target today (M7-03 scope). */
export type EntityType = "task" | "project";

/** The kind of mutation queued. */
export type MutationKind = "create" | "update" | "delete";

/** The queue's disposition of an operation. */
export type OperationStatus = "pending" | "conflict" | "failed";

/** One queued, replayable mutation. */
export interface QueuedOperation {
  /** Local, stable id (never sent to the server). */
  id: string;
  /** Monotonic, gap-free ordering key — the FIFO position. */
  seq: number;
  entityType: EntityType;
  entityId: string;
  mutation: MutationKind;
  /** Client-generated idempotency key; sent as `Idempotency-Key` on every replay attempt. */
  idempotencyKey: string;
  /** The revision the edit was based on (`null` for a create). */
  baseRevision: number | null;
  /** The request body fields (without `base_revision`, which the engine adds on replay). */
  payload: Record<string, unknown>;
  /** When the operation was queued (ISO 8601, UTC). */
  createdAt: string;
  /** How many replay attempts have failed in a retryable way. */
  attempts: number;
  status: OperationStatus;
  /** The last failure message, for the status surface. */
  lastError: string | null;
  /** For a conflict: the revision the server currently holds (never clobbered). */
  serverRevision: number | null;
}

/** The fields a caller supplies to enqueue an operation. */
export interface EnqueueInput {
  entityType: EntityType;
  entityId: string;
  mutation: MutationKind;
  /** Omit to have one generated. */
  idempotencyKey?: string;
  baseRevision?: number | null;
  payload?: Record<string, unknown>;
}

/** A read-only view of the queue for the status surface (M7-05 builds on this). */
export interface QueueSnapshot {
  /** Every operation, in FIFO order. */
  operations: QueuedOperation[];
  total: number;
  pending: number;
  conflicts: number;
  failed: number;
}

/** The persisted shape. `version` lets a future change migrate instead of guessing. */
interface StoredQueue {
  version: number;
  nextSeq: number;
  operations: QueuedOperation[];
}

/**
 * The stored-format version. Bump it when the on-disk shape changes **and** add a migration below;
 * an unrecognised version is discarded (never mis-read), which is safe because the server holds the
 * authoritative copy.
 */
export const QUEUE_STORE_VERSION = 1;

const QUEUE_KEY = "queue";

function emptyQueue(): StoredQueue {
  return { version: QUEUE_STORE_VERSION, nextSeq: 1, operations: [] };
}

function isStoredQueue(value: unknown): value is StoredQueue {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<StoredQueue>;
  return (
    typeof candidate.nextSeq === "number" &&
    Array.isArray(candidate.operations) &&
    candidate.operations.every(
      (op) => op && typeof op === "object" && typeof (op as QueuedOperation).id === "string",
    )
  );
}

/** A client-generated idempotency key, used to make a replayed mutation a no-op on the server. */
export function newIdempotencyKey(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The durable offline queue.
 *
 * Construct one per app (or per test) over a {@link KeyValueStore}. Two instances over the *same*
 * backing store see the same queued operations — which is exactly how a page reload is modelled:
 * a fresh instance re-reads what the previous one persisted.
 */
export class OfflineQueue {
  constructor(
    private readonly storage: KeyValueStore,
    private readonly clock: () => Date = () => new Date(),
    private readonly generateKey: () => string = newIdempotencyKey,
  ) {}

  private async load(): Promise<StoredQueue> {
    const raw = await this.storage.read(QUEUE_KEY);
    if (!raw) {
      return emptyQueue();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A corrupt blob cannot be recovered; start clean. The server is authoritative, so nothing is
      // lost that another pull cannot restore.
      return emptyQueue();
    }
    if (!isStoredQueue(parsed) || parsed.version !== QUEUE_STORE_VERSION) {
      return emptyQueue();
    }
    return parsed;
  }

  private async save(store: StoredQueue): Promise<void> {
    await this.storage.write(QUEUE_KEY, JSON.stringify(store));
  }

  /** Record a new operation at the back of the queue. */
  async enqueue(input: EnqueueInput): Promise<QueuedOperation> {
    const store = await this.load();
    const operation: QueuedOperation = {
      id: `op-${store.nextSeq}-${this.generateKey().slice(0, 8)}`,
      seq: store.nextSeq,
      entityType: input.entityType,
      entityId: input.entityId,
      mutation: input.mutation,
      idempotencyKey: input.idempotencyKey ?? this.generateKey(),
      baseRevision: input.baseRevision ?? null,
      payload: input.payload ?? {},
      createdAt: this.clock().toISOString(),
      attempts: 0,
      status: "pending",
      lastError: null,
      serverRevision: null,
    };
    store.operations.push(operation);
    store.nextSeq += 1;
    await this.save(store);
    return operation;
  }

  /** Every operation, in FIFO order. */
  async list(): Promise<QueuedOperation[]> {
    const store = await this.load();
    return [...store.operations].sort((a, b) => a.seq - b.seq);
  }

  /** A summary for the status surface. */
  async snapshot(): Promise<QueueSnapshot> {
    const operations = await this.list();
    return {
      operations,
      total: operations.length,
      pending: operations.filter((op) => op.status === "pending").length,
      conflicts: operations.filter((op) => op.status === "conflict").length,
      failed: operations.filter((op) => op.status === "failed").length,
    };
  }

  private async mutate(
    id: string,
    update: (op: QueuedOperation) => QueuedOperation,
  ): Promise<QueuedOperation | null> {
    const store = await this.load();
    const index = store.operations.findIndex((op) => op.id === id);
    if (index === -1) {
      return null;
    }
    const next = update(store.operations[index]);
    store.operations[index] = next;
    await this.save(store);
    return next;
  }

  /** Drop an operation — called after it has been replayed successfully. */
  async remove(id: string): Promise<void> {
    const store = await this.load();
    store.operations = store.operations.filter((op) => op.id !== id);
    await this.save(store);
  }

  /** Mark a stale `409`: the operation is kept (never clobbered) and surfaced as a conflict. */
  async markConflict(id: string, serverRevision: number | null): Promise<void> {
    await this.mutate(id, (op) => ({
      ...op,
      status: "conflict",
      serverRevision,
      lastError: "The item changed on the server; your edit was not applied.",
    }));
  }

  /** Mark a permanent failure (a non-retryable response): kept and surfaced. */
  async markFailed(id: string, message: string): Promise<void> {
    await this.mutate(id, (op) => ({ ...op, status: "failed", lastError: message }));
  }

  /**
   * Re-queue a conflicted operation against a new `base_revision` so the next flush can succeed
   * (the "keep mine" manual resolution, M7-05).
   *
   * The operation's payload is untouched (the local edit is never lost); only the revision it will
   * be replayed against changes. Passing `null` keeps the original `base_revision` — used when the
   * server's current revision is unknown, so the next flush re-attempts and re-learns it from the
   * resulting `409` instead of sending an unchecked write. Already-`pending` operations are returned
   * unchanged, which makes the resolution idempotent (a second "keep mine" is a no-op).
   */
  async rebase(id: string, baseRevision: number | null): Promise<QueuedOperation | null> {
    return this.mutate(id, (op) => {
      if (op.status === "pending") {
        return op;
      }
      return {
        ...op,
        status: "pending",
        baseRevision: baseRevision ?? op.baseRevision,
        serverRevision: null,
        lastError: null,
      };
    });
  }

  /** Record a retryable failure: the operation stays `pending` for the next reconnect. */
  async recordAttempt(id: string, message: string): Promise<void> {
    await this.mutate(id, (op) => ({
      ...op,
      attempts: op.attempts + 1,
      lastError: message,
    }));
  }

  /** Empty the queue (used when a full resync makes the local state authoritative again). */
  async clear(): Promise<void> {
    await this.save(emptyQueue());
  }
}

let sharedQueue: OfflineQueue | null = null;

/**
 * The app-wide durable queue. Lazily created over the shared backing store so the same data is
 * reused across reloads and shared by every hook that reports its state.
 */
export function getOfflineQueue(): OfflineQueue {
  if (!sharedQueue) {
    sharedQueue = new OfflineQueue(getSharedDurableStore());
  }
  return sharedQueue;
}
