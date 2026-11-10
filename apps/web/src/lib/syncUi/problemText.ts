/**
 * Wording for the writes the engine kept as problems (SYNC-11c): refused for good, or only partly
 * applied with both versions kept. The engine stores the reason code, never the server's text.
 */
import type { DesktopProblem } from "../desktop";
import { entityHref, entityLabel } from "./resolutionText";

export interface ProblemText {
  title: string;
  detail: string;
  /** Text fields with two versions: settle each with the resolver. */
  textConflicts: { field: string; mine: string; theirs: string }[];
  to: string | null;
}

const TEXT_FIELDS = new Set(["title", "description", "name"]);

const REASONS: Record<string, string> = {
  lost_on_restore: "This was created here after the server's backup and could not be added back.",
  validation_error: "The server did not accept the value.",
  not_found: "The item no longer exists on the server.",
  entity_deleted: "The item was deleted on the server.",
  forbidden_scope: "This device is not allowed to do that.",
  path_exists: "A note with that name already exists.",
  revision_ahead: "The server holds an older state than this device (it was restored).",
};

export function describeProblem(p: DesktopProblem): ProblemText {
  const what = entityLabel(p.entityType);
  const textConflicts = p.conflicts
    .filter((c) => TEXT_FIELDS.has(c.field) && typeof c.mine === "string" && typeof c.theirs === "string")
    .map((c) => ({ field: c.field, mine: c.mine as string, theirs: c.theirs as string }));
  const to = entityHref(p.entityType, p.entityId);
  if (p.entityType === "resolution") {
    return {
      title: "An undo was not applied",
      detail: "The value was changed again since, or it is not allowed any more. Nothing was overwritten.",
      textConflicts: [],
      to: null,
    };
  }
  if (p.kind === "conflict") {
    if (p.copy) {
      return {
        title: `A ${what} edit conflicted`,
        detail: `Your version was kept next to the original as "${p.copy.path}". Open the Notes page to compare and merge the two.`,
        textConflicts: [],
        to: "/notes",
      };
    }
    return {
      title: `A ${what} was changed on two devices`,
      detail:
        textConflicts.length > 0
          ? "Both versions of the text are kept below. Choose what the item should say."
          : "Some of your changes were not applied because the other device's change came first. Nothing was overwritten.",
      textConflicts,
      to,
    };
  }
  return {
    title: `A change to a ${what} could not be saved`,
    detail: REASONS[p.reason] ?? `The server refused it (${p.code ?? p.reason}). Nothing was changed on the server.`,
    textConflicts: [],
    to,
  };
}
