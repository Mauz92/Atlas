import { desktopApi } from "../lib/desktop";
import { newIdempotencyKey } from "../lib/offlineQueue";
import type { components } from "./schema";

export type UserPublic = components["schemas"]["UserPublic"];
export type SetupStatus = components["schemas"]["SetupStatus"];
export type SetupResult = components["schemas"]["SetupResult"];
export type RecoveryStatus = components["schemas"]["RecoveryStatus"];
export type RecoveryCodeIssued = components["schemas"]["RecoveryCodeIssued"];
export type NoteSummary = components["schemas"]["NoteSummaryOut"];
export type NoteDetail = components["schemas"]["NoteDetailOut"];
export type NoteLink = components["schemas"]["NoteLinkOut"];
export type NoteList = components["schemas"]["NoteListOut"];
export type NoteTask = components["schemas"]["NoteTaskOut"];
export type NoteProject = components["schemas"]["NoteProjectOut"];
export type Task = components["schemas"]["TaskOut"];
export type TaskList = components["schemas"]["TaskListOut"];
export type TaskStatus = components["schemas"]["TaskStatus"];
export type TaskPriority = components["schemas"]["TaskPriority"];
export type TaskView = components["schemas"]["TaskView"];
export type DueState = components["schemas"]["DueState"];
export type Project = components["schemas"]["ProjectOut"];
export type ProjectList = components["schemas"]["ProjectListOut"];
export type ProjectProgress = components["schemas"]["ProjectProgressOut"];
export type CredentialProvider = components["schemas"]["CredentialProvider"];
export type CalendarSyncState = components["schemas"]["SyncState"];
export type CalendarCursorHealth = components["schemas"]["CursorHealth"];
export type CalendarSyncStatus = components["schemas"]["CalendarSyncStatusOut"];
export type ProviderSyncStatus = components["schemas"]["ProviderSyncStatusOut"];
export type CalendarCursorStatus = components["schemas"]["CalendarCursorStatusOut"];
export type ProviderSyncResult = components["schemas"]["ProviderSyncOut"];
export type ChangeFeed = components["schemas"]["ChangesOut"];
export type ChangeItem = components["schemas"]["ChangeOut"];
export type SyncDevice = components["schemas"]["DeviceInfo"];
export type Device = components["schemas"]["DeviceOut"];
export type DeviceList = components["schemas"]["DeviceListOut"];
export type WebPushConfig = components["schemas"]["WebPushConfigOut"];
export type ReminderTiming = components["schemas"]["ReminderTiming"];
export type ReminderPreferences = components["schemas"]["ReminderPreferencesOut"];
export type TaskReminder = components["schemas"]["TaskReminderOut"];
export type HomeTimeZone = components["schemas"]["HomeTimeZone"];
export type SearchResults = components["schemas"]["SearchOut"];
export type SearchTask = components["schemas"]["SearchTaskOut"];
export type InstanceInfo = components["schemas"]["InstanceInfo"];
export type RecurrencePreview = components["schemas"]["RecurrencePreviewOut"];

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown = undefined) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }

  /** The revision the server currently holds, for a 409 on a note or task update. */
  get currentRevision(): number | null {
    const detail = (this.body as { detail?: { current_revision?: number } } | undefined)?.detail;
    return typeof detail?.current_revision === "number" ? detail.current_revision : null;
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function readCsrfCookie(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)atlas_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function describe(detail: unknown, fallback: string): string {
  if (typeof detail === "string") {
    return detail;
  }
  if (Array.isArray(detail)) {
    // FastAPI validation errors: [{ loc: ["body", "email"], msg: "..." }]
    const lines = detail
      .map((item) => {
        const { loc, msg } = (item ?? {}) as { loc?: unknown; msg?: unknown };
        if (typeof msg !== "string") {
          return null;
        }
        const field = Array.isArray(loc) ? loc.filter((p) => p !== "body").join(".") : "";
        const text = msg.replace(/^Value error, /, "");
        return field ? `${field}: ${text}` : text;
      })
      .filter((line): line is string => line !== null);
    if (lines.length > 0) {
      return lines.join("; ");
    }
  }
  if (detail && typeof detail === "object" && "message" in detail) {
    const message = (detail as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return fallback;
}

/** A request may carry a client-generated idempotency key (replayed offline mutations, M7-03). */
export interface RequestOptions extends RequestInit {
  idempotencyKey?: string;
}

/**
 * Options for a task `PATCH` from the autosaving task detail (UX-04, ADR-0053): a retry of a
 * request whose outcome is unknown re-sends the same body under the **same** key, so the server
 * replays its stored answer instead of applying the change twice; `keepalive` lets a save started
 * while the page is being hidden finish after it unloads.
 */
export interface TaskUpdateOptions {
  idempotencyKey?: string;
  keepalive?: boolean;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { idempotencyKey, ...init } = options;
  const headers = new Headers(init.headers);
  if (idempotencyKey) {
    headers.set("Idempotency-Key", idempotencyKey);
  }
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const method = (init.method ?? "GET").toUpperCase();
  const desktop = desktopApi();
  if (!SAFE_METHODS.has(method) && !desktop) {
    const token = readCsrfCookie();
    if (token) {
      headers.set("X-CSRF-Token", token);
    }
  }

  // In the desktop app the host sends the request and attaches the device token (no cookie, no CSRF token).
  const response = desktop
    ? await desktop.fetch(path, { ...init, headers })
    : await fetch(path, { credentials: "include", ...init, headers });
  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const detail = (body as { detail?: unknown } | undefined)?.detail;
    throw new ApiError(response.status, describe(detail, response.statusText), body);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export const api = {
  setupStatus: () => apiFetch<SetupStatus>("/api/setup/status"),
  me: () => apiFetch<UserPublic>("/api/auth/me"),
  login: (email: string, password: string) =>
    apiFetch<UserPublic>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  setup: (email: string, password: string, displayName: string) =>
    apiFetch<SetupResult>("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ email, password, display_name: displayName }),
    }),
  logout: () => apiFetch<void>("/api/auth/logout", { method: "POST" }),
  updateProfile: (displayName: string) =>
    apiFetch<UserPublic>("/api/auth/me", {
      method: "PATCH",
      body: JSON.stringify({ display_name: displayName }),
    }),
  /** Every other session is signed out by the server; this browser receives a fresh one. */
  changePassword: (currentPassword: string, newPassword: string, revokeDevices = false) =>
    apiFetch<void>("/api/auth/password", {
      method: "POST",
      body: JSON.stringify({
        current_password: currentPassword,
        new_password: newPassword,
        revoke_devices: revokeDevices,
      }),
    }),
};

/**
 * Account recovery (AUTH-01, ADR-0067). The one-time code is in the response of `regenerate` and
 * `reset` (and of `setup`) and nowhere else; callers keep it in memory only, never in storage.
 */
export const recoveryApi = {
  status: () => apiFetch<RecoveryStatus>("/api/auth/recovery"),
  regenerate: (currentPassword: string) =>
    apiFetch<RecoveryCodeIssued>("/api/auth/recovery/regenerate", {
      method: "POST",
      body: JSON.stringify({ current_password: currentPassword }),
    }),
  /** Unauthenticated: sets a new password with the code and returns the replacement code. */
  reset: (email: string, recoveryCode: string, newPassword: string) =>
    apiFetch<RecoveryCodeIssued>("/api/auth/recovery/reset", {
      method: "POST",
      body: JSON.stringify({
        email,
        recovery_code: recoveryCode,
        new_password: newPassword,
      }),
    }),
};

/**
 * Sync devices (SYNC-06, ADR-0065): the desktop and phone apps signed in to this server. The
 * browser only lists, renames and signs them out; a device signs *itself* in with the account
 * password, so there is nothing here that shows or creates a token.
 */
export const devicesApi = {
  list: () => apiFetch<{ items: SyncDevice[] }>("/api/devices"),
  rename: (id: string, name: string) =>
    apiFetch<SyncDevice>(`/api/devices/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  revoke: (id: string) => apiFetch<void>(`/api/devices/${id}`, { method: "DELETE" }),
  revokeAll: () => apiFetch<{ revoked: number }>("/api/devices/revoke-all", { method: "POST" }),
};

export const instanceApi = {
  get: () => apiFetch<InstanceInfo>("/api/instance"),
};

/** The full data export (a zip) fetched with the session cookie, so a failure shows its real message. */
export async function fetchExport(): Promise<{ blob: Blob; filename: string }> {
  const response = await fetch("/api/export", { credentials: "include" });
  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const detail = (body as { detail?: unknown } | undefined)?.detail;
    throw new ApiError(response.status, describe(detail, response.statusText), body);
  }
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "atlas-export.zip";
  return { blob: await response.blob(), filename };
}

export const notesApi = {
  list: (folder?: string) =>
    apiFetch<NoteList>(`/api/notes${folder ? `?folder=${encodeURIComponent(folder)}` : ""}`),
  search: (query: string) =>
    apiFetch<NoteSummary[]>(`/api/notes/search?q=${encodeURIComponent(query)}`),
  get: (id: string) => apiFetch<NoteDetail>(`/api/notes/${id}`),
  create: (path: string, content: string) =>
    apiFetch<NoteDetail>("/api/notes", { method: "POST", body: JSON.stringify({ path, content }) }),
  /**
   * Replace a note's text if the server still holds `baseRevision` (a `409` otherwise). `keepalive`
   * lets a save started while the page is going away finish; browsers cap such bodies at 64 KiB, so
   * a larger note is sent without it (its local draft covers that case, UX-05).
   */
  update: (id: string, content: string, baseRevision: number, options: { keepalive?: boolean } = {}) => {
    const body = JSON.stringify({ content, base_revision: baseRevision });
    return apiFetch<NoteDetail>(`/api/notes/${id}`, {
      method: "PUT",
      body,
      keepalive: options.keepalive === true && body.length < 60_000,
    });
  },
  /** Re-index notes edited outside Atlas (the on-demand form of the periodic scan, ADR-0010). */
  reconcile: () => apiFetch<unknown>("/api/notes/reconcile", { method: "POST" }),
  saveConflictCopy: (id: string, content: string) =>
    apiFetch<NoteSummary>(`/api/notes/${id}/conflict`, {
      method: "POST",
      body: JSON.stringify({ content }),
    }),
  move: (id: string, path: string) =>
    apiFetch<NoteDetail>(`/api/notes/${id}/move`, { method: "POST", body: JSON.stringify({ path }) }),
  remove: (id: string) => apiFetch<void>(`/api/notes/${id}`, { method: "DELETE" }),
  /**
   * Create a task from a note and link the two (MU-06). The task fields are validated by the
   * server and its message is shown verbatim; the key makes a re-sent request create one task.
   */
  createTask: (id: string, title: string, fields: TaskFields = {}) =>
    apiFetch<Task>(`/api/notes/${id}/tasks`, {
      method: "POST",
      body: JSON.stringify({ title, ...fields }),
      idempotencyKey: newIdempotencyKey(),
    }),
  /**
   * Open `daily/<date>.md`, creating it if missing (MU-07). `date` is the viewer's calendar day;
   * calling it again returns the same, untouched note.
   */
  openDaily: (date: string) =>
    apiFetch<NoteDetail>("/api/notes/daily", { method: "POST", body: JSON.stringify({ date }) }),
  /** Create a note from a note in `templates/`; the server substitutes `{{date}}` and `{{title}}`. */
  createFromTemplate: (path: string, templateId: string, date: string) =>
    apiFetch<NoteDetail>("/api/notes/from-template", {
      method: "POST",
      body: JSON.stringify({ path, template_id: templateId, date }),
    }),
  createFolder: (path: string) =>
    apiFetch<{ path: string }>("/api/folders", { method: "POST", body: JSON.stringify({ path }) }),
  renameFolder: (path: string, newPath: string) =>
    apiFetch<{ path: string; moved_notes: number }>("/api/folders/rename", {
      method: "POST",
      body: JSON.stringify({ path, new_path: newPath }),
    }),
  removeFolder: (path: string) =>
    apiFetch<void>(`/api/folders?path=${encodeURIComponent(path)}`, { method: "DELETE" }),
};

export interface TaskListOptions {
  /** One of the primary views (Inbox / Today / Upcoming). */
  view?: TaskView;
  /** The caller's IANA zone, so "today" is the caller's calendar day (ADR-0014). */
  tz?: string;
  /** Only these statuses (M3-08 filter); the Kanban board groups by status client-side. */
  status?: TaskStatus | readonly TaskStatus[];
  /** Only tasks filed under this project (M4-02 filter). */
  projectId?: string;
  /** Inclusive lower bound on `due_at`, as an ISO 8601 instant (M4-06 planning windows). */
  dueFrom?: string;
  /** Inclusive upper bound on `due_at`, as an ISO 8601 instant (M4-06 planning windows). */
  dueTo?: string;
  /** Inclusive lower bound on `start_at`, as an ISO 8601 instant (scheduled work, MU-07). */
  startFrom?: string;
  /** Inclusive upper bound on `start_at`, as an ISO 8601 instant (scheduled work, MU-07). */
  startTo?: string;
  /** Only this priority (the server takes one value; MU-03). */
  priority?: string;
  /** Case-insensitive text search over title and description (MU-03). */
  q?: string;
  /** Maximum number of tasks to return (the server bounds it). */
  limit?: number;
}

/** The writable task fields a create/update may carry (the server validates all of them). */
export type TaskFields = Omit<
  components["schemas"]["TaskUpdateRequest"],
  "base_revision" | "completed_at"
>;

export const tasksApi = {
  /** List tasks. A `view` returns one of the primary views; `tz` is the caller's IANA zone. */
  list: (options: TaskListOptions = {}) => {
    const params = new URLSearchParams();
    if (options.view) {
      params.set("view", options.view);
    }
    if (options.tz) {
      params.set("tz", options.tz);
    }
    if (options.status) {
      // The server accepts a repeated or comma-separated `status` filter (ADR-0018).
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      params.set("status", statuses.join(","));
    }
    if (options.projectId) {
      params.set("project_id", options.projectId);
    }
    if (options.dueFrom) {
      params.set("due_from", options.dueFrom);
    }
    if (options.dueTo) {
      params.set("due_to", options.dueTo);
    }
    if (options.startFrom) {
      params.set("start_from", options.startFrom);
    }
    if (options.startTo) {
      params.set("start_to", options.startTo);
    }
    if (options.priority) {
      params.set("priority", options.priority);
    }
    if (options.q) {
      params.set("q", options.q);
    }
    if (options.limit) {
      params.set("limit", String(options.limit));
    }
    const query = params.toString();
    return apiFetch<TaskList>(`/api/tasks${query ? `?${query}` : ""}`);
  },
  /** One task (the detail panel re-reads it to recover from a stale-revision conflict). */
  get: (id: string) => apiFetch<Task>(`/api/tasks/${id}`),
  /**
   * Quick capture: a title is the only required field. `fields` may add server-validated fields
   * (for example the due date that Today capture sets). Every mutation below carries a fresh
   * `Idempotency-Key`, so a re-sent request is applied once (AGENTS.md §9).
   */
  create: (title: string, fields: TaskFields = {}) =>
    apiFetch<Task>("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ title, ...fields }),
      idempotencyKey: newIdempotencyKey(),
    }),
  complete: (task: Task) =>
    apiFetch<Task>(`/api/tasks/${task.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "completed", base_revision: task.revision }),
      idempotencyKey: newIdempotencyKey(),
    }),
  /**
   * Edit a task (MU-01 detail panel and Inbox triage). `changes` holds only the fields to change
   * (`null` clears a nullable field). It carries the task's `base_revision`, so a stale edit is
   * rejected with `409` instead of overwriting a newer one; the server validates every value and
   * the transition rules, and its message is surfaced verbatim.
   */
  update: (task: Task, changes: TaskFields, options: TaskUpdateOptions = {}) =>
    apiFetch<Task>(`/api/tasks/${task.id}`, {
      method: "PATCH",
      body: JSON.stringify({ ...changes, base_revision: task.revision }),
      idempotencyKey: options.idempotencyKey ?? newIdempotencyKey(),
      ...(options.keepalive ? { keepalive: true } : {}),
    }),
  /**
   * Move a task to another status (M4-03 board). Carries the task's `base_revision` so a stale
   * move is rejected with `409` instead of overwriting a newer edit. The server validates the
   * transition against the canonical state machine (ADR-0013) and rejects an invalid one with
   * `409`; the client-side transition table only exists to steer the UI.
   */
  setStatus: (task: Task, status: TaskStatus) =>
    apiFetch<Task>(`/api/tasks/${task.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status, base_revision: task.revision }),
      idempotencyKey: newIdempotencyKey(),
    }),
  /** The notes linked to a task (MU-06). */
  notes: (id: string) => apiFetch<{ notes: NoteSummary[] }>(`/api/tasks/${id}/notes`),
  /** Remove a task↔note link; neither the task nor the note is deleted. */
  unlinkNote: (taskId: string, noteId: string) =>
    apiFetch<void>(`/api/tasks/${taskId}/notes/${noteId}`, { method: "DELETE" }),
  /** A task's direct subtasks (any status), in capture order. */
  subtasks: (parentId: string) =>
    apiFetch<TaskList>(`/api/tasks?parent_task_id=${encodeURIComponent(parentId)}&limit=500`),
  /** Add a subtask; it inherits the parent's project on the server. */
  addSubtask: (parentId: string, title: string) =>
    apiFetch<Task>("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ title, parent_task_id: parentId }),
      idempotencyKey: newIdempotencyKey(),
    }),
  /**
   * What an RRULE means for a task anchored at `anchor` (naive wall-clock time in `timeZone`): the
   * server's own validation and occurrence engine (MU-04). Read-only; nothing is stored.
   */
  previewRecurrence: (rule: string, anchor: string, timeZone?: string, limit = 5) =>
    apiFetch<RecurrencePreview>("/api/tasks/recurrence/preview", {
      method: "POST",
      body: JSON.stringify({ rule, anchor, time_zone: timeZone || null, limit }),
    }),
  /** Delete a task (a soft delete on the server, so {@link tasksApi.restore} can undo it). */
  remove: (task: Task) =>
    apiFetch<void>(`/api/tasks/${task.id}`, {
      method: "DELETE",
      idempotencyKey: newIdempotencyKey(),
    }),
  /** Undo a delete: the task returns with its id and history. */
  restore: (taskId: string) =>
    apiFetch<Task>(`/api/tasks/${taskId}/restore`, {
      method: "POST",
      idempotencyKey: newIdempotencyKey(),
    }),
};

/** The writable project fields (the server validates all of them; its messages are shown verbatim). */
export type ProjectFields = Omit<
  components["schemas"]["ProjectUpdateRequest"],
  "base_revision"
>;
export type ProjectNotes = components["schemas"]["ProjectNotesOut"];

export const projectsApi = {
  /**
   * The caller's live projects, in capture order. Each carries its derived `progress` (M4-04), so
   * the planning views can show project context without a per-task request.
   */
  list: () => apiFetch<ProjectList>("/api/projects"),
  get: (id: string) => apiFetch<Project>(`/api/projects/${id}`),
  /** Create a project (MU-02). */
  create: (name: string, fields: ProjectFields = {}) =>
    apiFetch<Project>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ ...fields, name }),
      idempotencyKey: newIdempotencyKey(),
    }),
  /**
   * Edit, archive (`status: "archived"`) or restore (`status: "active"`) a project. Carries the
   * project's `base_revision`, so a stale edit is rejected with `409` instead of overwriting.
   */
  update: (project: Project, changes: ProjectFields) =>
    apiFetch<Project>(`/api/projects/${project.id}`, {
      method: "PATCH",
      body: JSON.stringify({ ...changes, base_revision: project.revision }),
      idempotencyKey: newIdempotencyKey(),
    }),
  /** The notes linked to a project (M4-05). */
  notes: (id: string) => apiFetch<ProjectNotes>(`/api/projects/${id}/notes`),
  linkNote: (projectId: string, noteId: string) =>
    apiFetch<void>(`/api/projects/${projectId}/notes/${noteId}`, { method: "PUT" }),
  unlinkNote: (projectId: string, noteId: string) =>
    apiFetch<void>(`/api/projects/${projectId}/notes/${noteId}`, { method: "DELETE" }),
};

export const searchApi = {
  /**
   * Unified search (MU-05): notes, tasks and projects whose words start with every word of `q`,
   * at most `limit` of each kind. The server validates the text and the limit; its message is
   * shown verbatim.
   */
  search: (q: string, options: { limit?: number; signal?: AbortSignal } = {}) => {
    const params = new URLSearchParams({ q });
    if (options.limit) {
      params.set("limit", String(options.limit));
    }
    return apiFetch<SearchResults>(`/api/search?${params.toString()}`, {
      signal: options.signal,
    });
  },
};

export const calendarApi = {
  /**
   * The caller's calendar sync status (M5-08), derived server-side from the sync cursors: per
   * provider/calendar, whether the account is connected, the last successful sync, the state and
   * the last error. Read-only; it never contacts a provider.
   */
  syncStatus: () => apiFetch<CalendarSyncStatus>("/api/calendar/sync-status"),
  /**
   * Trigger one read-only sync for a provider (M5-08). Idempotent — repeating it never duplicates an
   * event. It returns per-calendar counts only, never a cursor value or event content.
   */
  syncProvider: (provider: CredentialProvider) =>
    apiFetch<ProviderSyncResult>(`/api/calendar/providers/${provider}/sync`, { method: "POST" }),
};

/** Options for the change-feed pull (M7-01). */
export interface ChangeFeedOptions {
  /** The cursor to pull after. Defaults to 0 (the whole retained change set, incl. tombstones). */
  since?: number;
  /** Maximum changes per page (1…500). */
  limit?: number;
}

export const changesApi = {
  /**
   * The caller's change feed (M7-01): everything that changed after `since`, ordered by the
   * monotonic per-user cursor, including `delete` tombstones. When the cursor predates the retention
   * floor the server answers `resync_required` (M7-02) and the client must full-resync.
   */
  list: (options: ChangeFeedOptions = {}) => {
    const params = new URLSearchParams();
    params.set("since", String(options.since ?? 0));
    if (options.limit !== undefined) {
      params.set("limit", String(options.limit));
    }
    return apiFetch<ChangeFeed>(`/api/changes?${params.toString()}`);
  },
};

/** A Web Push subscription registration (M8-02): a `web` destination with its client keys. */
export interface WebPushSubscriptionRegistration {
  channel: "web";
  endpoint: string;
  p256dh: string;
  auth: string;
  platform?: string;
}

export const notificationsApi = {
  /**
   * Whether Web Push is available and, if so, the VAPID public key to subscribe with (M8-02). The
   * private key is never returned; `enabled` is false when the server has no key pair configured.
   */
  config: () => apiFetch<WebPushConfig>("/api/notifications/config"),
  /** Register (or refresh) this browser's web-push destination. Idempotent on `(channel, endpoint)`. */
  registerDevice: (registration: WebPushSubscriptionRegistration) =>
    apiFetch<Device>("/api/notifications/devices", {
      method: "POST",
      body: JSON.stringify(registration),
    }),
  /** The caller's registered destinations (non-secret metadata only). */
  listDevices: () => apiFetch<DeviceList>("/api/notifications/devices"),
  /** Unregister this browser's web-push destination. Idempotent. */
  unregisterDevice: (endpoint: string) =>
    apiFetch<void>(
      `/api/notifications/devices?channel=web&endpoint=${encodeURIComponent(endpoint)}`,
      { method: "DELETE" },
    ),
  /**
   * The caller's default reminder timing (M8-05): `default` is `null` when no default is set.
   * Read-only and strictly user-scoped.
   */
  reminderPreferences: () => apiFetch<ReminderPreferences>("/api/notifications/reminders"),
  /**
   * Set (or clear, with `null`) the caller's default reminder timing (M8-05). Idempotent: the single
   * per-user default is upserted and every inherited task is rescheduled server-side.
   */
  updateReminderPreferences: (timing: ReminderTiming | null) =>
    apiFetch<ReminderPreferences>("/api/notifications/reminders", {
      method: "PUT",
      body: JSON.stringify({ default: timing }),
    }),
  /** The owner's home time zone (ADR-0068 Q6): used for tasks that carry no zone; `null` = UTC. */
  homeTimeZone: () => apiFetch<HomeTimeZone>("/api/notifications/time-zone"),
  /** Set (or clear, with `null`) the home time zone; the server recomputes affected reminders. */
  setHomeTimeZone: (timeZone: string | null) =>
    apiFetch<HomeTimeZone>("/api/notifications/time-zone", {
      method: "PUT",
      body: JSON.stringify({ time_zone: timeZone }),
    }),
  /** One task's reminder: its override, the timing in force and when it fires (M8-05). */
  taskReminder: (taskId: string) => apiFetch<TaskReminder>(`/api/tasks/${taskId}/reminder`),
  /**
   * Set (or clear, with `null`) one task's reminder override (M8-05). Takes precedence over the
   * caller's default and reschedules just that task's durable reminder.
   */
  setTaskReminder: (taskId: string, timing: ReminderTiming | null) =>
    apiFetch<TaskReminder>(`/api/tasks/${taskId}/reminder`, {
      method: "PUT",
      body: JSON.stringify({ timing }),
    }),
};

export type { components };