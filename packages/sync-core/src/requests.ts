import type { HttpRequest } from "./ports.ts";
import { PLURAL, type QueueOp } from "./types.ts";

/** The one place that knows how a queued operation maps to HTTP (SYNC_PROTOCOL 6). */
export function buildOpRequest(
  op: QueueOp,
  entityType: "task" | "project" | "note" | "resolution",
): Omit<HttpRequest, "headers"> {
  if (op.action === "undo") {
    return { method: "POST", path: `/api/sync/resolutions/${op.entityId}/undo` };
  }
  const plural = PLURAL[entityType as "task" | "project" | "note"];
  const id = op.entityId;
  switch (op.action) {
    case "create":
      return { method: "POST", path: `/api/${plural}`, body: { id, ...op.fields } };
    case "patch":
      return {
        method: "PATCH",
        path: `/api/${plural}/${id}`,
        body: { ...op.fields, base_revision: op.base },
      };
    case "delete":
      return {
        method: "DELETE",
        path: `/api/${plural}/${id}`,
        query: { base_revision: op.base ?? 0 },
      };
    case "restore":
      return { method: "POST", path: `/api/${plural}/${id}/restore` };
    case "put":
      return {
        method: "PUT",
        path: `/api/notes/${id}`,
        body: { content: op.content, base_revision: op.base, base_hash: op.baseHash },
      };
    case "move":
      return {
        method: "POST",
        path: `/api/notes/${id}/move`,
        body: { ...op.fields, base_revision: op.base },
      };
    default:
      throw new Error(`unknown action ${String(op.action)}`);
  }
}
