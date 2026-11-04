import type { LocalStore } from "../ports.ts";
import type { Problem, QueueOp } from "../types.ts";

/** The M7 queue snapshot shape (`apps/web/src/lib/offlineQueue.ts`), so the existing status UI can read the core. */
export interface LegacyQueuedOperation {
  id: string;
  seq: number;
  entityType: "task" | "project";
  entityId: string;
  mutation: "create" | "update" | "delete";
  idempotencyKey: string;
  baseRevision: number | null;
  payload: Record<string, unknown>;
  createdAt: string;
  attempts: number;
  status: "pending" | "conflict" | "failed";
  lastError: string | null;
  serverRevision: number | null;
}

export interface LegacyQueueSnapshot {
  operations: LegacyQueuedOperation[];
  total: number;
  pending: number;
  conflicts: number;
  failed: number;
}

const MUTATION = { create: "create", patch: "update", delete: "delete" } as const;

/** Map the core's queue and problems onto the M7 shape. Notes and undo have no M7 equivalent and are omitted. */
export async function legacyQueueSnapshot(store: LocalStore): Promise<LegacyQueueSnapshot> {
  const { queue, problems } = await store.transaction(async (tx) => ({
    queue: await tx.listQueue(),
    problems: await tx.listProblems(),
  }));
  const operations: LegacyQueuedOperation[] = [];
  const row = (op: QueueOp, status: LegacyQueuedOperation["status"], problem?: Problem): void => {
    if ((op.type !== "task" && op.type !== "project") || !(op.action in MUTATION)) return;
    operations.push({
      id: op.id, seq: op.seq, entityType: op.type, entityId: op.entityId,
      mutation: MUTATION[op.action as keyof typeof MUTATION], idempotencyKey: op.key,
      baseRevision: op.base ?? op.userBase, payload: op.fields,
      createdAt: new Date(op.createdAt).toISOString(), attempts: Math.max(0, op.attempts - 1),
      status, lastError: problem?.code ?? null, serverRevision: problem?.conflicts[0]?.serverRevision ?? null,
    });
  };
  for (const op of queue) row(op, "pending");
  void problems;
  return {
    operations,
    total: operations.length,
    pending: operations.length,
    conflicts: problems.filter((p) => p.kind === "conflict").length,
    failed: problems.filter((p) => p.kind === "failed").length,
  };
}
