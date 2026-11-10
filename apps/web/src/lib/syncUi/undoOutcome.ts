/**
 * What an undo answered, in words (SYNC-11a, SYNC_PROTOCOL 9, R-48).
 *
 * An undo is *strict*: it is applied only if nothing changed the field since, so "changed again since"
 * is the common answer on a busy field and must read as a normal, safe outcome ("nothing was
 * overwritten"), not as an error. Input is the HTTP status and the JSON body the server sends
 * (`{error, detail, conflicts, reason, follow_up, resolution}`), whatever the transport (REST or the
 * sync-core engine's recorded answer).
 */
import { entityLabel, fieldLabel, followUpFor, type FollowUp, type ResolutionLike } from "./resolutionText";

export type UndoOutcomeKind =
  | "undone"
  | "already_had_value"
  | "changed_since"
  | "entity_deleted"
  | "invalid_value"
  | "path_exists"
  | "already_undone"
  | "not_undoable"
  | "gone"
  | "unreachable"
  | "queued"
  | "failed";

export interface UndoOutcome {
  kind: UndoOutcomeKind;
  /** Shown to the person. */
  message: string;
  /** Nothing was written and the entry can be tried again later (not an error). */
  safe: boolean;
  /** The list must be read again (the entry changed on the server). */
  refresh: boolean;
  followUp: FollowUp | null;
}

interface WireBody {
  error?: string;
  detail?: unknown;
  reason?: string;
  conflicts?: { field?: string; reason?: string }[];
  follow_up?: { kind: string; href?: string | null } | null;
  resolution?: ResolutionLike;
  applied?: boolean;
}

function asBody(body: unknown): WireBody {
  return body && typeof body === "object" ? (body as WireBody) : {};
}

/** The outcome of a 2xx answer (`applied` false = the field already held the value). */
export function undoSucceeded(r: ResolutionLike, applied: boolean): UndoOutcome {
  const label = fieldLabel(r.field);
  return {
    kind: applied ? "undone" : "already_had_value",
    message: applied
      ? r.rule === "path_later_wins"
        ? "Undone: the note is back where it was."
        : `Undone: the ${label} has its earlier value again.`
      : `Nothing to change: the ${label} already had its earlier value. The entry is marked as undone.`,
    safe: true,
    refresh: true,
    followUp: null,
  };
}

/** The outcome of a refused or failed undo. `status` 0 means the server could not be reached. */
export function undoRefused(r: ResolutionLike, status: number, rawBody: unknown): UndoOutcome {
  const body = asBody(rawBody);
  const what = entityLabel(r.entity_type);
  const label = fieldLabel(r.field);
  const reason = body.conflicts?.[0]?.reason;
  const base = { safe: true, refresh: false, followUp: null as FollowUp | null };

  if (status === 0) {
    return { ...base, kind: "unreachable", message: "Could not reach the server. Nothing was changed. Try again when you are online." };
  }
  if (status === 404) {
    return {
      ...base,
      kind: "gone",
      refresh: true,
      message: "This entry is no longer available. Atlas keeps these entries for a limited time.",
    };
  }
  if (status === 409 && body.error === "conflict" && reason === "changed_since") {
    return {
      ...base,
      kind: "changed_since",
      message: `Not undone: the ${label} was changed again since. Atlas never overwrites a newer value. If you want the earlier value, set it yourself.`,
    };
  }
  if (status === 409 && body.error === "conflict" && (reason === "invalid_value" || reason === "invalid_transition")) {
    return {
      ...base,
      kind: "invalid_value",
      message: `Not undone: the earlier ${label} is not allowed any more${typeof body.detail === "string" && body.detail ? ` (${body.detail})` : ""}. Nothing was changed.`,
    };
  }
  if (status === 409 && body.error === "entity_deleted") {
    return {
      ...base,
      kind: "entity_deleted",
      message: `Not undone: the ${what} was deleted since, and an undo never brings a deleted item back.`,
    };
  }
  if (status === 409 && body.error === "path_exists") {
    return {
      ...base,
      kind: "path_exists",
      message: "Not undone: another note already uses the earlier location. Nothing was changed.",
    };
  }
  if (status === 409 && body.error === "already_undone") {
    return { ...base, kind: "already_undone", refresh: true, message: "This was already undone." };
  }
  if (status === 409 && body.error === "not_undoable") {
    const merged: ResolutionLike = { ...r, ...(body.resolution ?? {}), follow_up: body.follow_up ?? r.follow_up };
    return {
      ...base,
      kind: "not_undoable",
      refresh: true,
      followUp: followUpFor(merged),
      message: "This kind of change cannot be undone in one step.",
    };
  }
  if (status === 429) {
    return { ...base, kind: "failed", message: "The server asked to slow down. Try again in a moment." };
  }
  return { ...base, safe: false, kind: "failed", message: "The undo did not work and nothing was changed. Try again." };
}
