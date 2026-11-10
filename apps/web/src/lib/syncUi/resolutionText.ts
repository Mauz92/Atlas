/**
 * Wording for "changed on another device" (SYNC-11a, SYNC_PROTOCOL 9).
 *
 * Pure functions: the components render what these return and decide nothing (AGENTS.md 6, 7.4).
 * Input is the resolution record in the shape the server and `@atlas/sync-core` both use. The record
 * never holds task, project or note text (only simple fields, paths and revisions), so nothing here
 * can show text either; a title is looked up by the caller from the entity itself and passed in.
 */

export interface ResolutionLike {
  id: string;
  entity_type: string;
  entity_id: string;
  rule: string;
  field?: string | null;
  kept_revision?: number | null;
  has_loser: boolean;
  loser?: unknown;
  detail?: string | null;
  device_id?: string | null;
  undoes_id?: string | null;
  undone_at?: string | null;
  created_at: string;
  undoable: boolean;
  undo_blocked?: string | null;
  follow_up?: { kind: string; href?: string | null } | null;
}

/** Names the UI knows. A device token cannot list devices, so the shell may know none (R-74). */
export interface Names {
  devices: ReadonlyMap<string, string>;
  /** This device's id, or `null` in a browser. */
  ownDeviceId: string | null;
  projects?: ReadonlyMap<string, string>;
}

export const NO_NAMES: Names = { devices: new Map(), ownDeviceId: null };

const FIELD_LABELS: Record<string, string> = {
  status: "status",
  priority: "priority",
  due_at: "due date",
  start_at: "start",
  time_zone: "time zone",
  duration_minutes: "duration",
  project_id: "project",
  parent_task_id: "parent task",
  recurrence_rule: "repeat rule",
  completed_at: "completion time",
  start_date: "start date",
  end_date: "end date",
  color: "colour",
  path: "location",
};

export function fieldLabel(field: string | null | undefined): string {
  if (!field) return "a field";
  return FIELD_LABELS[field] ?? field.replace(/_/g, " ");
}

export function entityLabel(type: string): string {
  return type === "task" ? "task" : type === "project" ? "project" : type === "note" ? "note" : "item";
}

/** Where the entity lives in the app (task panel deep link, project page, note deep link). */
export function entityHref(type: string, id: string): string | null {
  if (type === "task") return `/tasks?task=${encodeURIComponent(id)}`;
  if (type === "project") return `/projects/${encodeURIComponent(id)}`;
  if (type === "note") return `/notes?open=${encodeURIComponent(id)}`;
  return null;
}

/** Was this entry written by a device other than this one? A browser (`own` null) has no device of its own. */
export function isFromOtherDevice(r: Pick<ResolutionLike, "device_id">, ownDeviceId: string | null): boolean {
  if (ownDeviceId === null) return r.device_id != null;
  return r.device_id !== ownDeviceId;
}

/** "Kim's laptop", "this device", "the web app" (a browser session) or "another device". */
export function deviceLabel(r: Pick<ResolutionLike, "device_id">, names: Names): string {
  if (r.device_id == null) return "the web app";
  if (names.ownDeviceId !== null && r.device_id === names.ownDeviceId) return "this device";
  return names.devices.get(r.device_id) ?? "another device";
}

const STATUS_LABELS: Record<string, string> = {
  inbox: "Inbox",
  todo: "To do",
  next: "Next",
  in_progress: "In progress",
  waiting: "Waiting",
  blocked: "Blocked",
  completed: "Completed",
  done: "Done",
  cancelled: "Cancelled",
  canceled: "Cancelled",
  active: "Active",
  paused: "Paused",
  on_hold: "On hold",
  archived: "Archived",
};

function titleCase(value: string): string {
  const text = value.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A simple field's value as people read it. Text fields are never passed here. */
export function formatFieldValue(field: string | null | undefined, value: unknown, names: Pick<Names, "projects"> = {}): string {
  if (value === null || value === undefined || value === "") return "empty";
  if (field === "status" && typeof value === "string") return STATUS_LABELS[value] ?? titleCase(value);
  if (field === "priority" && typeof value === "string") return titleCase(value);
  if (field === "project_id" && typeof value === "string") return names.projects?.get(value) ?? "another project";
  if ((field === "due_at" || field === "start_at" || field === "completed_at") && typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
    }
  }
  if (field === "start_date" || field === "end_date") return String(value);
  if (field === "duration_minutes" && typeof value === "number") return `${value} min`;
  if (typeof value === "string") return value.length > 80 ? `${value.slice(0, 77)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "a value";
}

/** "5 minutes ago", "yesterday"; the exact time belongs in a `title`/`<time>` attribute. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "at an unknown time";
  const seconds = Math.round((then - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

export function absoluteTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export type UndoState =
  | { kind: "available" }
  | { kind: "undone" }
  /** Cannot be undone; `reason` says why in words and `followUp` what to do instead. */
  | { kind: "blocked"; reason: string; followUp: FollowUp | null };

export interface FollowUp {
  /** The action in words ("Delete it again", "Open the note's history"). */
  label: string;
  /** An in-app route, or `null` when the app has no page for it. */
  to: string | null;
}

export interface ResolutionText {
  /** One sentence: what happened and on which device. */
  headline: string;
  /** The values involved, for simple fields only. */
  values: { label: string; value: string }[];
  /** What the entity is (a lookup by the caller may add its title). */
  entity: string;
  entityTo: string | null;
  when: string;
  whenExact: string;
  undo: UndoState;
  /** Whether this is the log's own record of an undo (muted in a list, never a notice). */
  isUndoEntry: boolean;
}

/** The follow-up the server names for a resolution that cannot be undone, as a link the app can follow. */
export function followUpFor(r: ResolutionLike): FollowUp | null {
  const kind = r.follow_up?.kind;
  if (!kind) return null;
  if (kind === "delete_again") {
    return { label: `Delete the ${entityLabel(r.entity_type)} again`, to: entityHref(r.entity_type, r.entity_id) };
  }
  if (kind === "note_history") {
    return { label: "Open the note and compare it with the other version", to: entityHref("note", r.entity_id) };
  }
  if (kind === "rename") return { label: "Rename the note", to: entityHref("note", r.entity_id) };
  return { label: "Open it", to: entityHref(r.entity_type, r.entity_id) };
}

const BLOCKED_REASON: Record<string, string> = {
  already_undone: "Already undone.",
  value_not_stored: "The earlier value was too large to keep, so Atlas cannot put it back.",
  is_undo: "This is the record of an undo; there is nothing to undo.",
};

function undoStateOf(r: ResolutionLike): UndoState {
  if (r.undone_at) return { kind: "undone" };
  if (r.undoable) return { kind: "available" };
  const followUp = followUpFor(r);
  let reason = r.undo_blocked ? BLOCKED_REASON[r.undo_blocked] : undefined;
  if (!reason || r.undo_blocked === "rule_not_undoable") {
    if (r.rule === "edit_wins_over_delete") {
      reason = "An edit and a delete met; the edit won and the item came back. Atlas will not delete it again for you.";
    } else if (r.rule === "note_merged") {
      reason = "Both versions were merged into the note. The merge cannot be reversed in one step.";
    } else if (r.rule === "path_collision") {
      reason = "The name was already taken, so the note got another name. Rename it to what you prefer.";
    } else {
      reason = "This change cannot be undone automatically.";
    }
  }
  return { kind: "blocked", reason, followUp };
}

/** Everything a card shows for one log entry. */
export function describeResolution(r: ResolutionLike, names: Names = NO_NAMES, now: number = Date.now()): ResolutionText {
  const who = deviceLabel(r, names);
  const what = entityLabel(r.entity_type);
  const values: { label: string; value: string }[] = [];
  let headline: string;
  switch (r.rule) {
    case "simple_later_wins":
      headline = `On ${who}, the ${fieldLabel(r.field)} of a ${what} was changed at the same time as on another device. The later change was kept.`;
      if (r.has_loser) values.push({ label: `Replaced ${fieldLabel(r.field)}`, value: formatFieldValue(r.field, r.loser, names) });
      break;
    case "path_later_wins":
      headline = `On ${who}, a note was moved at the same time as on another device. The later move was kept.`;
      if (r.has_loser) values.push({ label: "Replaced location", value: formatFieldValue("path", r.loser) });
      break;
    case "edit_wins_over_delete":
      headline = `A ${what} deleted on one device was edited on ${who}. The edit won and the ${what} is back.`;
      break;
    case "note_merged":
      headline = `A note was edited on ${who} while it had changed elsewhere. Atlas merged both edits into one text.`;
      break;
    case "path_collision":
      headline = `A note from ${who} had a name that was already taken, so it was saved under another name.`;
      if (r.detail) values.push({ label: "Names", value: r.detail });
      break;
    case "undo":
      headline = r.field
        ? `The ${fieldLabel(r.field)} of a ${what} was put back by an undo on ${who}.`
        : `A change to a ${what} was undone on ${who}.`;
      break;
    default:
      headline = `A ${what} was changed on ${who}.`;
  }
  return {
    headline,
    values,
    entity: what,
    entityTo: entityHref(r.entity_type, r.entity_id),
    when: relativeTime(r.created_at, now),
    whenExact: absoluteTime(r.created_at),
    undo: undoStateOf(r),
    isUndoEntry: r.rule === "undo",
  };
}

/** Entries worth a banner: another device's, not an undo record, not already undone, not older than `since` (ms). */
export function unseenNotices<T extends ResolutionLike>(items: readonly T[], ownDeviceId: string | null, since: number): T[] {
  return items.filter(
    (r) =>
      r.rule !== "undo" &&
      !r.undone_at &&
      isFromOtherDevice(r, ownDeviceId) &&
      new Date(r.created_at).getTime() > since,
  );
}

export function noticeSummary(count: number): string {
  return count === 1 ? "1 change was made on another device" : `${count} changes were made on another device`;
}
