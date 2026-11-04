/** `atlas/sync/resolution_rules.py::undo_status`, as the model server needs it. */

export const SIMPLE_LATER_WINS = "simple_later_wins";
export const EDIT_WINS_OVER_DELETE = "edit_wins_over_delete";
export const NOTE_MERGED = "note_merged";
export const PATH_COLLISION = "path_collision";
export const PATH_LATER_WINS = "path_later_wins";
export const UNDO = "undo";

const UNDOABLE = new Set([SIMPLE_LATER_WINS, PATH_LATER_WINS]);

export interface Undoability {
  undoable: boolean;
  reason: string | null;
  followUp: { kind: string; href: string | null } | null;
}

export function undoStatus(input: {
  rule: string;
  entityId: string;
  keptRevision: number | null;
  field: string | null;
  hasLoser: boolean;
  undone: boolean;
}): Undoability {
  const no = (reason: string, followUp: Undoability["followUp"] = null): Undoability => ({
    undoable: false,
    reason,
    followUp,
  });
  if (input.rule === UNDO) return no("is_undo");
  if (input.undone) return no("already_undone");
  if (input.rule === NOTE_MERGED) {
    const href =
      input.keptRevision !== null ? `/api/notes/${input.entityId}/history/${input.keptRevision}` : null;
    return no("rule_not_undoable", { kind: "note_history", href });
  }
  if (input.rule === EDIT_WINS_OVER_DELETE) return no("rule_not_undoable", { kind: "delete_again", href: null });
  if (input.rule === PATH_COLLISION) return no("rule_not_undoable", { kind: "rename", href: null });
  if (UNDOABLE.has(input.rule) && input.field !== null && input.hasLoser)
    return { undoable: true, reason: null, followUp: null };
  return no("value_not_stored");
}
