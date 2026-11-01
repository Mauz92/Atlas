import type { components } from "./schema";

export type UserPublic = components["schemas"]["UserPublic"];
export type SetupStatus = components["schemas"]["SetupStatus"];
export type NoteSummary = components["schemas"]["NoteSummaryOut"];
export type NoteDetail = components["schemas"]["NoteDetailOut"];
export type NoteLink = components["schemas"]["NoteLinkOut"];
export type NoteList = components["schemas"]["NoteListOut"];
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
export type Device = components["schemas"]["DeviceOut"];
export type DeviceList = components["schemas"]["DeviceListOut"];
export type WebPushConfig = components["schemas"]["WebPushConfigOut"];
export type ReminderTiming = components["schemas"]["ReminderTiming"];
export type ReminderPreferences = components["schemas"]["ReminderPreferencesOut"];
export type TaskReminder = components["schemas"]["TaskReminderOut"];

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown = undefined) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }

  /** The revision the server currently holds, for a 409 on a note update. */
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
  if (!SAFE_METHODS.has(method)) {
    const token = readCsrfCookie();
    if (token) {
      headers.set("X-CSRF-Token", token);
    }
  }

  const response = await fetch(path, { credentials: "include", ...init, headers });
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
    apiFetch<UserPublic>("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ email, password, display_name: displayName }),
    }),
  logout: () => apiFetch<void>("/api/auth/logout", { method: "POST" }),
};

export const notesApi = {
  list: (folder?: string) =>
    apiFetch<NoteList>(`/api/notes${folder ? `?folder=${encodeURIComponent(folder)}` : ""}`),
  search: (query: string) =>
    apiFetch<NoteSummary[]>(`/api/notes/search?q=${encodeURIComponent(query)}`),
  get: (id: string) => apiFetch<NoteDetail>(`/api/notes/${id}`),
  create: (path: string, content: string) =>
    apiFetch<NoteDetail>("/api/notes", { method: "POST", body: JSON.stringify({ path, content }) }),
  update: (id: string, content: string, baseRevision: number) =>
    apiFetch<NoteDetail>(`/api/notes/${id}`, {
      method: "PUT",
      body: JSON.stringify({ content, base_revision: baseRevision }),
    }),
  saveConflictCopy: (id: string, content: string) =>
    apiFetch<NoteSummary>(`/api/notes/${id}/conflict`, {
      method: "POST",
      body: JSON.stringify({ content }),
    }),
  move: (id: string, path: string) =>
    apiFetch<NoteDetail>(`/api/notes/${id}/move`, { method: "POST", body: JSON.stringify({ path }) }),
  remove: (id: string) => apiFetch<void>(`/api/notes/${id}`, { method: "DELETE" }),
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
}

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
    const query = params.toString();
    return apiFetch<TaskList>(`/api/tasks${query ? `?${query}` : ""}`);
  },
  /** Quick capture: a title is the only required field. */
  create: (title: string) =>
    apiFetch<Task>("/api/tasks", { method: "POST", body: JSON.stringify({ title }) }),
  complete: (task: Task) =>
    apiFetch<Task>(`/api/tasks/${task.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "completed", base_revision: task.revision }),
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
    }),
};

export const projectsApi = {
  /**
   * The caller's live projects, in capture order. Each carries its derived `progress` (M4-04), so
   * the planning views can show project context without a per-task request.
   */
  list: () => apiFetch<ProjectList>("/api/projects"),
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