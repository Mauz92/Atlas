/**
 * The PLATFORM PORT of the Atlas desktop client (SYNC-09, ADR-0069).
 *
 * Everything the desktop client needs from the host that is not plain TypeScript is one of these
 * interfaces. The Tauri shell implements them with thin Rust commands (`apps/desktop`); a fake
 * implements them for tests (`./testing`); an Electron host would implement the same interfaces
 * with Node modules, which is the point: the Windows no-admin result (R-36) may move the desktop
 * to Electron, and then only the adapter is rewritten, never this package.
 *
 * Rules every implementation must keep (each is tested against the fake and, for Tauri, in Rust):
 *  - The device token never crosses this boundary: `HttpPort` attaches it, `SessionPort` stores it,
 *    nothing returns it.
 *  - Paths given to `NotesFolderPort` are relative, `/`-separated, and confined to the one granted root.
 *  - `RowDb.commit` is atomic and durable (a crash leaves all of a batch or none of it).
 */

// --- local database (per-row; never whole-state blobs) -------------------------------------------

/** The tables of the local database. A host rejects any other name. */
export const TABLES = [
  "entities",
  "queue",
  "meta",
  "resolutions",
  "problems",
  "drafts",
  "notes_index",
  "settings",
  "scheduler",
] as const;
export type Table = (typeof TABLES)[number];

export type DbOp =
  | {
      op: "put";
      table: Table;
      key: string;
      /** A JSON document. */
      value: string;
      /** Sort key of `list` (the queue's `seq`); 0 when the table has no order. */
      ord?: number;
      /** A small label for filtering later (the entity type). */
      kind?: string;
    }
  | { op: "del"; table: Table; key: string }
  | { op: "clear"; table: Table };

export interface RowDb {
  /** Open the file (creating it) and migrate it forward. Rejects a database newer than this build. */
  open(): Promise<{ schemaVersion: number }>;
  get(table: Table, key: string): Promise<string | null>;
  /** All documents of a table ordered by `ord`, then key. */
  list(table: Table): Promise<string[]>;
  /** Apply the operations in ONE transaction (all or nothing, durable when it resolves). */
  commit(ops: DbOp[]): Promise<void>;
}

// --- network ------------------------------------------------------------------------------------

export interface HttpPortRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Starts with `/api/`. The host prepends the configured origin and attaches the bearer token. */
  path: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface HttpPortResponse {
  status: number;
  /** Lower-case names. */
  headers: Record<string, string>;
  body: string;
}

/** Rejects only when no response arrived (connection lost, timeout, TLS failure). */
export interface HttpPort {
  request(req: HttpPortRequest): Promise<HttpPortResponse>;
}

// --- session (sign-in and the secure token) ------------------------------------------------------

export interface DeviceRecord {
  id: string;
  name: string;
  platform?: string | null;
  [key: string]: unknown;
}

export type SignInFailure = "invalid_credentials" | "rate_limited" | "unreachable" | "insecure_url" | "update_required" | "keystore_unavailable" | "server_error";

export type SignInResult =
  | { ok: true; device: DeviceRecord; baseUrl: string }
  | { ok: false; failure: SignInFailure; detail: string };

export interface SessionInfo {
  signedIn: boolean;
  baseUrl: string | null;
  device: DeviceRecord | null;
  /** The keystore could not be reached (no Secret Service, locked): the app cannot sign in or sync. */
  keystoreError: string | null;
}

export interface SessionPort {
  /** `POST /api/devices` with e-mail and password; the host stores the token in the OS keystore. */
  signIn(input: { baseUrl: string; email: string; password: string; deviceName: string }): Promise<SignInResult>;
  info(): Promise<SessionInfo>;
  /** Forget the token and the base URL (after a 401 or when the user signs out). Idempotent. */
  clear(): Promise<void>;
  /** Revoke this device on the server (best effort) and then `clear`. */
  signOut(): Promise<void>;
}

// --- notes folder -------------------------------------------------------------------------------

export type FolderEntryStatus = "ok" | "too_large" | "invalid_utf8";

export interface FolderEntry {
  /** Relative to the root, `/` separated. */
  path: string;
  size: number;
  mtimeMs: number;
  /** SHA-256 hex of the bytes (the server's `content_hash`). Empty for `too_large`. */
  hash: string;
  status: FolderEntryStatus;
}

export type WriteResult = { result: "written"; hash: string } | { result: "changed" } | { result: "exists" };
export type RenameResult = "renamed" | "changed" | "exists" | "missing";
export type TrashResult = "trashed" | "changed" | "missing";

/** The one granted notes folder. A host with no folder granted rejects every call with `no_root`. */
export interface NotesFolderPort {
  /** The granted root (display only), or `null`. */
  root(): Promise<string | null>;
  /** Native folder dialog; the webview never supplies a path. `null`: cancelled. */
  choose(): Promise<string | null>;
  /**
   * Every `*.md` file under the root (dot-directories, `.atlas*`, editor temp files, non-Markdown files
   * skipped). `full` hashes every file; otherwise a file whose size and mtime did not change keeps its
   * cached hash. Rejects with `root_missing` when the folder is not there (never an empty list).
   */
  scan(full: boolean): Promise<FolderEntry[]>;
  read(path: string): Promise<string>;
  /**
   * Atomic write (temp file, fsync, rename; directory fsync where the OS allows). `expectedHash`: a
   * string = the file must still have that hash, `null` = it must not exist. The check is repeated
   * right before the rename.
   */
  write(path: string, content: string, expectedHash: string | null): Promise<WriteResult>;
  rename(from: string, to: string, expectedHash: string): Promise<RenameResult>;
  /** Move to `<root>/.atlas-trash/` instead of deleting. */
  trash(path: string, expectedHash: string): Promise<TrashResult>;
  /** Hints that something under the root changed (Access events and Atlas temp files already dropped). */
  onChange(listener: () => void): () => void;
}

// --- everything else ----------------------------------------------------------------------------

export type NotifyPermission = "granted" | "denied" | "default" | "unavailable";

export interface NotifierPort {
  permission(): Promise<NotifyPermission>;
  requestPermission(): Promise<NotifyPermission>;
  show(input: { title: string; body: string; tag: string | null }): Promise<void>;
}

export interface TrayPort {
  /** Close button hides the window and keeps the app running (ADR-0068 Q2). */
  setCloseToTray(enabled: boolean): Promise<void>;
  /** Tooltip / status line of the tray icon (content free: a state word, a count). */
  setStatus(text: string): Promise<void>;
  /** The user chose a tray menu entry. */
  onMenu(listener: (item: "open" | "sync_now") => void): () => void;
}

export interface AutostartPort {
  isEnabled(): Promise<boolean>;
  setEnabled(enabled: boolean): Promise<void>;
}

export interface LifecyclePort {
  /** The window gained focus, or the machine woke from sleep. */
  onWake(listener: () => void): () => void;
  /** Show the main window (e.g. for a tapped notification). */
  showWindow(): Promise<void>;
  /** Replace the current page by the sign-in page (after a 401). */
  gotoSignIn(reason: "signed_out" | "update_required" | null): Promise<void>;
  /** Quit the whole app (the tray menu's Quit). */
  quit(): Promise<void>;
}

export interface TimerPort {
  /** Returns a cancel function. */
  setTimeout(fn: () => void, ms: number): () => void;
  setInterval(fn: () => void, ms: number): () => void;
  /** Monotonic milliseconds. */
  monotonic(): number;
  /** Wall-clock milliseconds (display and reminder instants only). */
  wallTime(): number;
  /** Offset of the device zone from UTC at an instant, in minutes (positive east). */
  utcOffsetMinutes(atMs: number): number;
}

export interface CryptoPort {
  uuid(): string;
  random(): number;
  /** SHA-256 hex of the UTF-8 bytes of `text`. */
  sha256(text: string): Promise<string>;
}

export interface PlatformPort {
  db: RowDb;
  http: HttpPort;
  session: SessionPort;
  folder: NotesFolderPort;
  notifier: NotifierPort;
  tray: TrayPort;
  autostart: AutostartPort;
  lifecycle: LifecyclePort;
  timers: TimerPort;
  crypto: CryptoPort;
}
