import type { Page } from "@playwright/test";

/**
 * Shared helpers for the M7-06 failure-mode E2E suite.
 *
 * The suite runs the **real** client against a **mocked** HTTP API: authentication and the change
 * feed are stubbed so the app boots into its authenticated `/sync` route without the live backend,
 * and task mutations are answered deterministically so a stale-revision `409`, a network failure and
 * a successful replay can each be produced on demand.
 *
 * The offline queue itself is genuinely the app's own durable store: the app reads and writes it in
 * IndexedDB (`atlas-offline` → `kv` → `queue`, see `apps/web/src/lib/queueStorage.ts`). Because
 * M7-03..M7-05 build the queue and its status/reconciliation surfaces but no *editing* UI enqueues an
 * offline mutation yet, this suite seeds a queued operation **into that same store** to represent the
 * state an offline edit leaves behind, then drives the real `/sync` UI to observe and flush it.
 */

/** The authenticated user the mocked `/api/auth/me` returns. */
export const USER = {
  id: "11111111-1111-1111-1111-111111111111",
  email: "owner@atlas.test",
  display_name: "Owner",
};

/** The entity id the queued operation targets. */
export const TASK_ID = "task-1";

/** A queued `update` operation, in the exact persisted shape `offlineQueue.ts` reads. */
export interface SeededOperation {
  id: string;
  seq: number;
  entityType: string;
  entityId: string;
  mutation: string;
  idempotencyKey: string;
  baseRevision: number | null;
  payload: Record<string, unknown>;
  createdAt: string;
  attempts: number;
  status: string;
  lastError: string | null;
  serverRevision: number | null;
}

/** A pending offline `update` for {@link TASK_ID}, based on revision 1. */
export function queuedUpdate(overrides: Partial<SeededOperation> = {}): SeededOperation {
  return {
    id: "op-1-seed",
    seq: 1,
    entityType: "task",
    entityId: TASK_ID,
    mutation: "update",
    idempotencyKey: "idem-seed-1",
    baseRevision: 1,
    payload: { title: "Edited offline" },
    createdAt: "2026-10-27T09:00:00.000Z",
    attempts: 0,
    status: "pending",
    lastError: null,
    serverRevision: null,
    ...overrides,
  };
}

/** One task mutation the app attempted, captured for assertions. */
export interface TaskMutation {
  body: Record<string, unknown>;
  baseRevision: number | null;
}

/** Mutable per-test controls for the mocked API. */
export interface ApiControls {
  /** When true, a queued task mutation fails as if the network were down. */
  offline: boolean;
  /** The revision the mocked server currently holds; a write based on anything else is a stale `409`. */
  serverRevision: number;
  /** Successful (200) task mutations the app made, in order. */
  successfulWrites: TaskMutation[];
  /** Every task `PATCH` the app attempted, in order. */
  attemptedWrites: TaskMutation[];
}

/**
 * Install deterministic API mocks on `page`: authentication, an empty change feed, and task
 * mutations whose behaviour follows the returned {@link ApiControls}.
 */
export async function installApiMocks(page: Page): Promise<ApiControls> {
  const controls: ApiControls = {
    offline: false,
    serverRevision: 1,
    successfulWrites: [],
    attemptedWrites: [],
  };

  await page.route("**/api/setup/status", (route) =>
    route.fulfill({ json: { setup_required: false } }),
  );
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: USER }));
  await page.route("**/api/changes**", (route) =>
    route.fulfill({
      json: { changes: [], since: 0, next_since: 0, has_more: false, resync_required: false },
    }),
  );

  await page.route("**/api/tasks/**", async (route) => {
    const request = route.request();
    if (request.method() !== "PATCH") {
      await route.fulfill({ json: {} });
      return;
    }
    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
    const baseRevision = typeof body.base_revision === "number" ? body.base_revision : null;
    controls.attemptedWrites.push({ body, baseRevision });

    if (controls.offline) {
      // A dropped connection: the fetch rejects, so the queue keeps the operation for the next try.
      await route.abort("internetdisconnected");
      return;
    }
    if (baseRevision !== controls.serverRevision) {
      // A stale write: the server rejects it and reports the revision it actually holds.
      await route.fulfill({
        status: 409,
        json: {
          detail: {
            current_revision: controls.serverRevision,
            message: "The item changed on the server; your edit was not applied.",
          },
        },
      });
      return;
    }
    controls.successfulWrites.push({ body, baseRevision });
    await route.fulfill({
      json: { id: TASK_ID, title: (body.title as string) ?? "Task", revision: baseRevision + 1 },
    });
  });

  return controls;
}

/**
 * Write queued operations straight into the app's durable IndexedDB store — the same store the
 * `/sync` page reads. This represents the state an offline edit leaves behind (see the module doc).
 */
export async function seedOfflineQueue(page: Page, operations: SeededOperation[]): Promise<void> {
  const stored = JSON.stringify({ version: 1, nextSeq: operations.length + 1, operations });
  await page.evaluate(async (value) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("atlas-offline", 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("kv")) {
          db.createObjectStore("kv");
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put(value, "queue");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("seeding the queue failed"));
      };
      request.onerror = () => reject(request.error ?? new Error("opening IndexedDB failed"));
    });
  }, stored);
}

/** The queue's own `role="status"` badge text (e.g. "Pending sync", "All synced", "Sync conflict"). */
export function queueBadge(page: Page) {
  return page.getByRole("status");
}

/** The panel's overall-state badge (e.g. "Up to date", "Offline", "Conflicts"). */
export function overallBadge(page: Page) {
  return page.locator(".sync-panel-badge");
}
