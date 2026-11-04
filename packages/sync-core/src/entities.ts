/**
 * Apply rules: how server states, tombstones and acknowledgements change the local mirror.
 *
 * Rules (SYNC_PROTOCOL 3, 8.1; simulation findings R-40):
 *  - a feed/GET state applies by revision (`incoming < held` is a no-op);
 *  - an acknowledgement is a HISTORICAL snapshot: it may fill a gap, never overwrite newer or
 *    tombstoned state, and the entity is read again at the next pull (`refetch`);
 *  - a delete acknowledgement tombstones (the user's intent) and is re-read as well;
 *  - a tombstone is remembered even for an entity never held (an unacknowledged create of it
 *    may still be in flight and must not bring it back, seed 681);
 *  - a live state newer than a tombstone revives it (edit wins over delete, rule 4).
 */

import type { Sha256 } from "./ports.ts";
import {
  BOOKKEEPING_KEYS,
  type EntityType,
  type Json,
  type LocalEntity,
  type ServerState,
} from "./types.ts";
import type { StoreTx } from "./ports.ts";

export class IntegrityError extends Error {}

export interface ApplyOptions {
  sha256?: Sha256 | undefined;
  /** Planted defect for the simulation: apply states older than the held one. */
  applyStale?: boolean | undefined;
}

export function newEntity(id: string, type: EntityType): LocalEntity {
  return { id, type, server: null, deleted: false, deletedRevision: null, refetch: false };
}

/** Parse the `data` of a feed item or the body of a GET/write response. */
export function parseServerState(data: Record<string, Json>): ServerState {
  const fields: Record<string, Json> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!BOOKKEEPING_KEYS.has(key)) fields[key] = value;
  }
  const revisions = data["field_revisions"];
  const fieldRevisions: Record<string, number> = {};
  if (revisions && typeof revisions === "object" && !Array.isArray(revisions)) {
    for (const [k, v] of Object.entries(revisions)) if (typeof v === "number") fieldRevisions[k] = v;
  }
  return {
    revision: Number(data["revision"]),
    fields,
    fieldRevisions,
    content: typeof data["content"] === "string" ? data["content"] : null,
    contentHash: typeof data["content_hash"] === "string" ? data["content_hash"] : null,
  };
}

export function isDeletedPayload(data: Record<string, Json> | null | undefined): boolean {
  return !data || data["deleted_at"] != null;
}

function sameState(a: ServerState | null, b: ServerState): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Apply a live server state. Returns whether the mirror changed.
 * `authoritative` is documented for readers: pulls and re-reads call this; acknowledgements go
 * through {@link applyAck}.
 */
export async function applyLive(
  tx: StoreTx,
  type: EntityType,
  id: string,
  data: Record<string, Json>,
  options: ApplyOptions,
): Promise<boolean> {
  const state = parseServerState(data);
  if (!Number.isFinite(state.revision)) throw new IntegrityError(`state of ${id} has no revision`);
  const local = (await tx.getEntity(id)) ?? newEntity(id, type);
  if (local.type !== type) throw new IntegrityError(`entity ${id} changed type`);
  if (
    !options.applyStale &&
    local.server &&
    !local.deleted &&
    state.revision < local.server.revision
  )
    return false;
  if (
    !options.applyStale &&
    local.deleted &&
    local.deletedRevision !== null &&
    state.revision <= local.deletedRevision
  )
    return false;
  if (type === "note") {
    const sameText =
      local.server && !local.deleted && state.content === null && local.server.contentHash === state.contentHash;
    if (sameText) state.content = local.server!.content;
    if (state.content !== null && state.contentHash !== null && options.sha256) {
      if (options.sha256(state.content) !== state.contentHash)
        throw new IntegrityError(`note ${id}: body and hash disagree`);
    }
  }
  const changed = local.deleted || !sameState(local.server, state);
  local.server = state;
  local.deleted = false;
  local.deletedRevision = null;
  await tx.putEntity(local);
  return changed;
}

/** Apply a tombstone (`revision` is `null` when unknown, e.g. from our own delete answer). */
export async function applyTombstone(
  tx: StoreTx,
  type: EntityType,
  id: string,
  revision: number | null,
  options: ApplyOptions,
): Promise<boolean> {
  const local = (await tx.getEntity(id)) ?? newEntity(id, type);
  if (local.deleted) {
    if (revision === null || local.deletedRevision === null || revision <= local.deletedRevision)
      return false;
    local.deletedRevision = revision;
    await tx.putEntity(local);
    return true;
  }
  if (
    !options.applyStale &&
    revision !== null &&
    local.server &&
    revision < local.server.revision
  )
    return false; // a tombstone older than what we hold (the entity came back since)
  local.deleted = true;
  local.deletedRevision = revision;
  await tx.putEntity(local);
  return true;
}

/** Apply the body of a successful write: gap-fill only (R-40). Marks the entity for a re-read. */
export async function applyAck(
  tx: StoreTx,
  type: EntityType,
  id: string,
  body: Record<string, Json>,
  options: ApplyOptions & { trustAck?: boolean | undefined },
): Promise<void> {
  const local = await tx.getEntity(id);
  if (options.trustAck) {
    // planted defect: install the historical body as current state and skip the re-read
    await tx.putEntity({ ...(local ?? newEntity(id, type)), server: parseServerState(body), deleted: false, deletedRevision: null });
    return;
  }
  if (!local || (!local.server && !local.deleted)) {
    await applyLive(tx, type, id, body, options);
  } else if (!local.deleted) {
    await applyLive(tx, type, id, body, options); // guarded by the revision comparison
  }
  const after = (await tx.getEntity(id)) ?? newEntity(id, type);
  after.refetch = true;
  await tx.putEntity(after);
}

/** Our own delete was acknowledged (204): the tombstone is the user's intent; re-read later. */
export async function applyDeleteAck(
  tx: StoreTx,
  type: EntityType,
  id: string,
  options: ApplyOptions & { trustAck?: boolean | undefined },
): Promise<void> {
  await applyTombstone(tx, type, id, null, { ...options, applyStale: true });
  if (options.trustAck) return;
  const after = (await tx.getEntity(id)) ?? newEntity(id, type);
  after.refetch = true;
  await tx.putEntity(after);
}
