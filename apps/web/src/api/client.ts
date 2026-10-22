import type { components } from "./schema";

export type UserPublic = components["schemas"]["UserPublic"];
export type SetupStatus = components["schemas"]["SetupStatus"];
export type NoteSummary = components["schemas"]["NoteSummaryOut"];
export type NoteDetail = components["schemas"]["NoteDetailOut"];
export type NoteLink = components["schemas"]["NoteLinkOut"];
export type NoteList = components["schemas"]["NoteListOut"];

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

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
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

export type { components };
