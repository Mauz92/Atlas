import type { Resolution } from "../api/client";
import type { DesktopProblem, DesktopSyncApi } from "../lib/desktop";
import type { ResolutionsSource } from "../lib/syncUi/source";
import type { UndoOutcome } from "../lib/syncUi/undoOutcome";

export function resolution(over: Partial<Resolution> = {}): Resolution {
  return {
    id: "r1",
    entity_type: "task",
    entity_id: "t1",
    rule: "simple_later_wins",
    field: "status",
    kept_revision: 4,
    has_loser: true,
    loser: "in_progress",
    detail: null,
    device_id: "d-laptop",
    undoes_id: null,
    undone_at: null,
    undone_by: null,
    created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    undoable: true,
    undo_blocked: null,
    follow_up: null,
    ...over,
  } as Resolution;
}

/** A source over fixed pages (`pages[0]` is the newest page). */
export function fakeSource(pages: Resolution[][], over: Partial<ResolutionsSource> = {}): ResolutionsSource & { undoCalls: { id: string; key: string }[] } {
  const undoCalls: { id: string; key: string }[] = [];
  const outcome: UndoOutcome = { kind: "undone", message: "Undone: the status has its earlier value again.", safe: true, refresh: false, followUp: null };
  return {
    kind: "rest",
    undoCalls,
    ownDeviceId: async () => null,
    deviceNames: async () => new Map([["d-laptop", "Kim's laptop"]]),
    page: async (cursor) => {
      const index = cursor === null ? 0 : Number(cursor);
      return { items: pages[index] ?? [], next: index + 1 < pages.length ? String(index + 1) : null };
    },
    undo: async (r, key) => {
      undoCalls.push({ id: r.id, key });
      return outcome;
    },
    ...over,
  };
}

/** The shell's engine verbs over fixed data (SYNC-11c tests). */
export function fakeDesktopSync(over: Partial<DesktopSyncApi> = {}): DesktopSyncApi & { calls: string[] } {
  const calls: string[] = [];
  const note = (name: string) => async () => {
    calls.push(name);
  };
  return {
    calls,
    resolutions: async () => [],
    problems: async () => [],
    dismissProblem: async (id) => {
      calls.push(`dismiss ${id}`);
    },
    undo: async (id) => {
      calls.push(`undo ${id}`);
      return { status: 200, body: { applied: true } };
    },
    confirmRestore: note("confirmRestore"),
    discardLocal: note("discardLocal"),
    resolveText: async (id, field, text) => {
      calls.push(`resolveText ${id} ${field} ${text}`);
    },
    resumeAfterUpdate: note("resumeAfterUpdate"),
    ...over,
  };
}

export function problem(over: Partial<DesktopProblem> = {}): DesktopProblem {
  return {
    id: "p1",
    kind: "conflict",
    reason: "conflict",
    status: 409,
    code: "conflict",
    action: "patch",
    entityType: "task",
    entityId: "t1",
    at: 1_800_000_000_000,
    detail: null,
    conflicts: [{ field: "title", reason: "text_conflict", serverRevision: 2, theirs: "Their title", mine: "My title" }],
    copy: null,
    ...over,
  };
}
