import type { EntityType, Json, LocalEntity, NoteDraft, QueueOp } from "./types.ts";

/** What the user sees: the server's state with the pending local operations laid over it. */
export interface EntityView {
  id: string;
  type: EntityType;
  fields: Record<string, Json>;
  /** Notes: the working text if there is one, else the last downloaded text (`null`: not yet). */
  content: string | null;
  deleted: boolean;
  /** The revision of the server state this view derives from (`null` before the first ack). */
  serverRevision: number | null;
  /** Operations of this entity that the server has not acknowledged. */
  pendingOps: number;
}

export function materialise(
  entity: LocalEntity,
  queue: readonly QueueOp[],
  draft: NoteDraft | undefined,
): EntityView {
  const fields: Record<string, Json> = { ...(entity.server?.fields ?? {}) };
  let deleted = entity.deleted;
  let pendingOps = 0;
  for (const op of queue) {
    if (op.entityId !== entity.id) continue;
    pendingOps++;
    if (op.action === "create") {
      Object.assign(fields, op.fields);
      deleted = false;
    } else if (op.action === "patch") {
      Object.assign(fields, op.fields);
      deleted = false; // a pending edit revives a deleted entity (edit wins over delete)
    } else if (op.action === "move") Object.assign(fields, op.fields);
    else if (op.action === "delete") deleted = true;
    else if (op.action === "restore") deleted = false;
    else if (op.action === "put") deleted = false;
  }
  let content = entity.server?.content ?? null;
  if (entity.type === "note") {
    const create = queue.find((o) => o.entityId === entity.id && o.action === "create");
    if (create && typeof create.fields["content"] === "string") content = create.fields["content"];
    delete fields["content"];
    if (draft) content = draft.text;
  }
  return {
    id: entity.id,
    type: entity.type,
    fields,
    content,
    deleted,
    serverRevision: entity.server?.revision ?? null,
    pendingOps,
  };
}
