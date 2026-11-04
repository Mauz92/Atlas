/** Data shapes shared by the core, its stores and its hosts (SYNC-08). */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type EntityType = "task" | "project" | "note";
export const ENTITY_TYPES: readonly EntityType[] = ["task", "project", "note"];

/** The state of an entity as the server last reported it (never a pending local edit). */
export interface ServerState {
  revision: number;
  /** Task/project: the stored columns; note: `path`, `title`, `size_bytes`. */
  fields: Record<string, Json>;
  /** Field name -> the revision at which it last changed (tasks and projects). */
  fieldRevisions: Record<string, number>;
  /** Notes only: the text, or `null` while it has not been downloaded. */
  content: string | null;
  /** Notes only: the server's `content_hash` of `content`. */
  contentHash: string | null;
}

export interface LocalEntity {
  id: string;
  type: EntityType;
  /** `null` until the server told us about the entity (a create is still queued). */
  server: ServerState | null;
  /** A tombstone is known. `server` keeps the last live state. */
  deleted: boolean;
  /** The revision the tombstone had, or `null` when it came from our own delete acknowledgement. */
  deletedRevision: number | null;
  /** A write of ours was acknowledged: its answer is historical, read the entity again (R-40). */
  refetch: boolean;
}

export type OpAction = "create" | "patch" | "delete" | "restore" | "put" | "move" | "undo";

export interface QueueOp {
  /** Local operation id (never sent). */
  id: string;
  /** Enqueue order; the queue is strictly FIFO. */
  seq: number;
  /** `Idempotency-Key`, chosen when the operation is enqueued and never changed. */
  key: string;
  /** What is written: an entity type, or `resolution` for an undo. */
  type: EntityType | "resolution";
  action: OpAction;
  /** The entity (client-chosen id) or, for `undo`, the resolution id. */
  entityId: string;
  /** create: all fields (notes: path, content); patch: only the changed fields; move: `{path}`. */
  fields: Record<string, Json>;
  /** The revision of the user's copy when the user acted (`null`: not needed). */
  userBase: number | null;
  /** The revision an earlier acknowledged operation of the same entity produced (chained base). */
  chainBase: number | null;
  /** Frozen at the first send: a retry is byte-identical, including this base. */
  base: number | null;
  /** Notes (`put`), frozen at the first send. */
  baseHash: string | null;
  content: string | null;
  /** The first send happened: the request must not change any more. */
  frozen: boolean;
  attempts: number;
  /** Wall-clock enqueue time. Display only: never used for ordering (D11). */
  createdAt: number;
}

export interface ResolutionRecord {
  id: string;
  entity_type: string;
  entity_id: string;
  rule: string;
  field: string | null;
  kept_revision: number | null;
  has_loser: boolean;
  loser: Json;
  detail: string | null;
  device_id: string | null;
  undoes_id: string | null;
  undone_at: string | null;
  undone_by: string | null;
  created_at: string;
  undoable: boolean;
  undo_blocked: string | null;
  follow_up: { kind: string; href: string | null } | null;
}

export interface FieldConflict {
  field: string;
  reason: string;
  serverRevision: number | null;
  /** What the server holds (a text field), or `null` when it is not disclosed. */
  theirs: Json;
  /** What this device tried to write. Both versions are kept (AGENTS.md 8). */
  mine: Json;
}

/** A write the server refused or only partly applied. Kept as data until the user dismisses it. */
export interface Problem {
  id: string;
  kind: "failed" | "conflict";
  reason: string;
  status: number | null;
  code: string | null;
  opId: string;
  action: OpAction;
  entityType: EntityType | "resolution";
  entityId: string;
  at: number;
  detail: string | null;
  conflicts: FieldConflict[];
  /** A note save that lost: the text that was not applied (also in `copy` on the server). */
  mineText: string | null;
  /** The text typed after that save was sent, if any. */
  mineLatestText: string | null;
  /** The conflict copy the server saved for a rejected note save. */
  copy: { id: string; path: string; revision: number; content_hash: string } | null;
}

/** A note's local working copy, pinned to the revision it derives from (ADR-0054). */
export interface NoteDraft {
  entityId: string;
  text: string;
  /** What `text` derives from. `null` while an earlier save is in flight (set when it is answered). */
  baseRevision: number | null;
  baseHash: string | null;
  baseText: string | null;
  /** Operation whose frozen request holds `frozenText`: edits made since are not yet sent. */
  inFlightOp: string | null;
  frozenText: string | null;
  /** The save that was answered without text: `text` derives from this; rebase once the note is read. */
  rebaseFrom: string | null;
}

// --- wire shapes (the parts the core reads) -------------------------------------------------------

export interface WireChange {
  entity_type: string;
  entity_id: string;
  operation: "upsert" | "delete";
  cursor: number;
  revision?: number | null;
  data?: Record<string, Json> | null;
}

export interface WirePage {
  changes: WireChange[];
  since: number;
  next_since: number;
  has_more: boolean;
  resync_required: boolean;
  resync_reason: string | null;
  head?: number;
  floor?: number;
}

/** Keys of an entity payload that are bookkeeping, not editable fields. */
export const BOOKKEEPING_KEYS: ReadonlySet<string> = new Set([
  "id",
  "revision",
  "field_revisions",
  "deleted_at",
  "created_at",
  "updated_at",
  "sync",
  "content",
  "content_hash",
]);

/** The REST collection of each entity type. */
export const PLURAL: Record<EntityType, string> = {
  task: "tasks",
  project: "projects",
  note: "notes",
};

/** Text fields: a concurrent change is a conflict that keeps both versions (SYNC_PROTOCOL 6.2). */
export const TEXT_FIELDS: Record<EntityType, ReadonlySet<string>> = {
  task: new Set(["title", "description"]),
  project: new Set(["name", "description"]),
  note: new Set(),
};
