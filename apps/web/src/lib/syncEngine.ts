/**
 * Offline replay + change-feed sync engine (M7-03).
 *
 * Two responsibilities, both kept out of components (AGENTS.md §7.4):
 *
 * 1. **Replay.** {@link flushQueue} drains the durable {@link OfflineQueue} in FIFO order through the
 *    existing API, sending each operation's `Idempotency-Key` and `base_revision`. A retry reuses the
 *    same key, so the server treats a re-sent mutation as the same request — retrying never
 *    duplicates. A stale `409` is surfaced and the operation is **kept** (never clobbered); a network
 *    or `5xx` failure keeps the queue intact for the next reconnect.
 * 2. **Pull.** {@link pullChanges} advances a durable cursor by paging `GET /api/changes`, applying a
 *    page's changes only *before* the cursor moves past it (so a crash re-delivers rather than skips).
 *    When the server answers `resync_required` (the cursor predates the retention floor, M7-02) it
 *    triggers a full resync and resumes from the returned head instead of trusting the empty page.
 */

import { ApiError, apiFetch, changesApi, type ChangeFeed, type ChangeItem } from "../api/client";
import {
  getOfflineQueue,
  type EntityType,
  type OfflineQueue,
  type QueuedOperation,
  type QueueSnapshot,
} from "./offlineQueue";
import { getSharedDurableStore, type KeyValueStore } from "./queueStorage";

/* -------------------------------------------------------------------------------------------------
 * Cursor (durable)
 * ----------------------------------------------------------------------------------------------- */

/** Persisted cursor shape; versioned like the queue so a format change is explicit. */
interface StoredCursor {
  version: number;
  since: number;
  updatedAt: string;
}

export const CURSOR_STORE_VERSION = 1;
const CURSOR_KEY = "cursor";

/**
 * The durable change-feed cursor.
 *
 * A cursor that cannot be understood is treated as `0`, which makes the client re-pull from the start
 * — safe, because the server's change feed is idempotent and bounded by its retention window.
 */
export class SyncCursorStore {
  constructor(
    private readonly storage: KeyValueStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async get(): Promise<number> {
    const raw = await this.storage.read(CURSOR_KEY);
    if (!raw) {
      return 0;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StoredCursor>;
      if (parsed.version !== CURSOR_STORE_VERSION || typeof parsed.since !== "number") {
        return 0;
      }
      return parsed.since;
    } catch {
      return 0;
    }
  }

  async set(since: number): Promise<void> {
    const stored: StoredCursor = {
      version: CURSOR_STORE_VERSION,
      since,
      updatedAt: this.clock().toISOString(),
    };
    await this.storage.write(CURSOR_KEY, JSON.stringify(stored));
  }

  async reset(): Promise<void> {
    await this.storage.remove(CURSOR_KEY);
  }
}

/* -------------------------------------------------------------------------------------------------
 * Replay
 * ------------------------------------------------------------------------------------------------- */

const ENTITY_BASE: Record<EntityType, string> = {
  task: "/api/tasks",
  project: "/api/projects",
};

/**
 * Map one queued operation onto the ordinary entity API.
 *
 * `create` → `POST`, `update` → `PATCH` (carrying `base_revision`), `delete` → `DELETE`. Every request
 * carries the operation's `Idempotency-Key`. This is the only place that knows how an operation maps
 * to HTTP; the engine calls it behind an injectable `send` so it is unit-testable without a network.
 */
export async function sendOperation(operation: QueuedOperation): Promise<void> {
  const base = ENTITY_BASE[operation.entityType];
  if (!base) {
    throw new Error(`Unknown entity type: ${operation.entityType}`);
  }
  if (operation.mutation === "create") {
    await apiFetch(base, {
      method: "POST",
      body: JSON.stringify(operation.payload),
      idempotencyKey: operation.idempotencyKey,
    });
    return;
  }
  if (operation.mutation === "update") {
    await apiFetch(`${base}/${operation.entityId}`, {
      method: "PATCH",
      body: JSON.stringify({ ...operation.payload, base_revision: operation.baseRevision }),
      idempotencyKey: operation.idempotencyKey,
    });
    return;
  }
  await apiFetch(`${base}/${operation.entityId}`, {
    method: "DELETE",
    idempotencyKey: operation.idempotencyKey,
  });
}

/** The outcome of one replay pass. */
export interface FlushResult {
  /** Operations replayed and removed this pass. */
  sent: number;
  /** Operations marked permanently failed this pass. */
  failed: number;
  /** The first stale `409`, if any — surfaced, never clobbered. */
  conflict: QueuedOperation | null;
  /** True when the pass stopped early (a conflict or a retryable failure) with work left. */
  stopped: boolean;
  /** The queue snapshot after the pass. */
  queue: QueueSnapshot;
}

/**
 * Replay the queue, in order, once. Does not retry internally — a caller (or the next reconnect)
 * re-invokes it. Idempotency makes that safe.
 */
export async function flushQueue(
  queue: OfflineQueue,
  send: (operation: QueuedOperation) => Promise<void> = sendOperation,
): Promise<FlushResult> {
  let sent = 0;
  let failed = 0;
  let stopped = false;
  let conflict: QueuedOperation | null = null;

  const operations = await queue.list();
  for (const operation of operations) {
    // `conflict`/`failed` operations are not re-sent blindly; the user (M7-05) resolves them.
    if (operation.status !== "pending") {
      continue;
    }
    try {
      await send(operation);
      await queue.remove(operation.id);
      sent += 1;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // Stale write: keep the operation, record the server's revision, surface it. Never clobber.
        await queue.markConflict(operation.id, error.currentRevision);
        conflict = { ...operation, status: "conflict", serverRevision: error.currentRevision };
        stopped = true;
        break;
      }
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        // A permanent client error (bad payload, gone, forbidden): surface it and move on.
        await queue.markFailed(operation.id, error.message);
        failed += 1;
        continue;
      }
      // Network loss / 5xx: leave the queue for the next reconnect and stop this pass.
      await queue.recordAttempt(
        operation.id,
        error instanceof Error ? error.message : "Network error",
      );
      stopped = true;
      break;
    }
  }

  return { sent, failed, conflict, stopped, queue: await queue.snapshot() };
}

/* -------------------------------------------------------------------------------------------------
 * Pull
 * ------------------------------------------------------------------------------------------------- */

/** Dependencies of a pull, injectable so the engine is unit-testable without a network. */
export interface PullDeps {
  cursor: SyncCursorStore;
  /** Page the change feed from a cursor (`GET /api/changes?since=`). */
  listChanges: (since: number) => Promise<ChangeFeed>;
  /** Called when the server requires a full resync (the cursor predates the retention floor). */
  fullResync?: () => Promise<void> | void;
  /** Called with each page's changes *before* the cursor advances past them. */
  onChanges?: (changes: ChangeItem[]) => Promise<void> | void;
}

/** The outcome of a pull. */
export interface PullResult {
  /** Every change seen across the pages (empty on a resync). */
  changes: ChangeItem[];
  /** The cursor to send on the next pull. */
  nextSince: number;
  /** How many feed pages were fetched. */
  pages: number;
  /** True when the server signalled that the client must full-resync. */
  resyncRequired: boolean;
}

/**
 * Pull changes from a stored cursor, paging until `has_more` is false.
 *
 * The cursor advances only *after* a page's `onChanges` has run, so an interrupted pull re-delivers a
 * page rather than skipping it (applying is idempotent). If the server answers `resync_required`, the
 * engine runs the full resync and resumes from the returned head — it never trusts the empty page.
 */
export async function pullChanges(deps: PullDeps): Promise<PullResult> {
  let since = await deps.cursor.get();
  const changes: ChangeItem[] = [];
  let pages = 0;

  for (;;) {
    const page = await deps.listChanges(since);
    pages += 1;

    if (page.resync_required) {
      if (deps.fullResync) {
        await deps.fullResync();
      }
      await deps.cursor.set(page.next_since);
      return { changes, nextSince: page.next_since, pages, resyncRequired: true };
    }

    changes.push(...page.changes);
    if (deps.onChanges) {
      await deps.onChanges(page.changes);
    }
    since = page.next_since;
    await deps.cursor.set(since);

    if (!page.has_more) {
      break;
    }
  }

  return { changes, nextSince: since, pages, resyncRequired: false };
}

/* -------------------------------------------------------------------------------------------------
 * The engine
 * ------------------------------------------------------------------------------------------------- */

/** Everything the engine needs, wired to the real API by default. */
export interface SyncEngineDeps extends Partial<Omit<PullDeps, "cursor">> {
  queue: OfflineQueue;
  cursor: SyncCursorStore;
  /** How to replay one operation. Defaults to {@link sendOperation}. */
  send?: (operation: QueuedOperation) => Promise<void>;
}

/** A thin binder over {@link flushQueue} and {@link pullChanges} for the app and the status hook. */
export class SyncEngine {
  constructor(private readonly deps: SyncEngineDeps) {}

  /** Replay the queue once (called on reconnect / when the tab regains focus). */
  async flush(): Promise<FlushResult> {
    return flushQueue(this.deps.queue, this.deps.send ?? sendOperation);
  }

  /** Pull changes from the stored cursor, honouring `resync_required`. */
  async pull(): Promise<PullResult> {
    const listChanges = this.deps.listChanges ?? ((since: number) => changesApi.list({ since }));
    return pullChanges({
      cursor: this.deps.cursor,
      listChanges,
      fullResync: this.deps.fullResync,
      onChanges: this.deps.onChanges,
    });
  }

  /** A reconnect: replay pending work first, then pull what changed elsewhere. */
  async sync(): Promise<{ flush: FlushResult; pull: PullResult }> {
    const flush = await this.flush();
    const pull = await this.pull();
    return { flush, pull };
  }
}

let sharedCursor: SyncCursorStore | null = null;

/** The app-wide cursor, over the same durable backing as the queue so both survive a reload. */
export function getSyncCursor(): SyncCursorStore {
  if (!sharedCursor) {
    sharedCursor = new SyncCursorStore(getSharedDurableStore());
  }
  return sharedCursor;
}

/**
 * The app-wide engine, wired to the real queue, cursor and API. M7-04 grows the reconnect
 * reconciliation on top of this; M7-03 only exposes the pieces it builds on.
 */
export function getSyncEngine(): SyncEngine {
  return new SyncEngine({ queue: getOfflineQueue(), cursor: getSyncCursor() });
}
