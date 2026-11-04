/**
 * Everything the sync core needs from its host, as interfaces (SYNC-08, AGENTS.md 7.4).
 *
 * The core imports nothing from React, the DOM, `window`, `fetch` or `localStorage`: a host
 * (browser, Tauri, a test) injects a {@link Transport}, a {@link LocalStore}, a {@link Clock},
 * random sources and a {@link Logger}. Ordering is never decided by a clock (ADR-0059 D11): the
 * monotonic clock times backoff and request deadlines, the wall clock is display-only.
 */

import type {
  LocalEntity,
  NoteDraft,
  Problem,
  QueueOp,
  ResolutionRecord,
  Json,
} from "./types.ts";

// --- transport ------------------------------------------------------------------------------

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface HttpRequest {
  method: HttpMethod;
  /** Path starting with `/api/`; the host prepends the origin. */
  path: string;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  /** Complete headers: `Atlas-Sync`, `Authorization`, `Atlas-Epoch`, `Idempotency-Key`. */
  headers: Record<string, string>;
}

export interface HttpResponse {
  status: number;
  /** Parsed JSON, or `null` for an empty body. */
  body: unknown;
  /** Lower-case header names. */
  headers: Record<string, string>;
}

/**
 * Sends one request. It resolves with ANY HTTP response (also 4xx/5xx) and rejects only when no
 * response was received (connection lost, timeout, aborted): the outcome is then unknown and the
 * core retries the identical request.
 */
export interface Transport {
  send(request: HttpRequest): Promise<HttpResponse>;
}

/** Supplies the device bearer token (kept in the OS keystore by the host; never stored here). */
export interface Credentials {
  getToken(): Promise<string | null> | string | null;
}

// --- time and randomness ----------------------------------------------------------------------

export interface Clock {
  /** Monotonic milliseconds: used ONLY for backoff and request deadlines. */
  monotonic(): number;
  /** Wall-clock milliseconds: display only ("last synced"); may be wrong or jump (D11). */
  wallTime(): number;
}

export interface Random {
  /** A number in [0, 1). */
  next(): number;
}

export interface IdGenerator {
  /** A new UUID (version 4 or 7) used for client entity ids, operation ids and idempotency keys. */
  uuid(): string;
}

/** Fields of a log line are primitives only. The core never passes titles, text or note content. */
export type LogFields = Record<string, string | number | boolean | null>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

/** Hex SHA-256 of the UTF-8 bytes (the server's `content_hash`). Optional; verifies note bodies. */
export type Sha256 = (text: string) => string;

// --- local store ------------------------------------------------------------------------------

/** Operations inside one atomic transaction. */
export interface StoreTx {
  getEntity(id: string): Promise<LocalEntity | undefined>;
  putEntity(entity: LocalEntity): Promise<void>;
  removeEntity(id: string): Promise<void>;
  listEntities(): Promise<LocalEntity[]>;

  /** Queue, ascending by `seq`. */
  listQueue(): Promise<QueueOp[]>;
  putOp(op: QueueOp): Promise<void>;
  removeOp(id: string): Promise<void>;

  getMeta<T extends Json>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: Json): Promise<void>;
  removeMeta(key: string): Promise<void>;

  listResolutions(): Promise<ResolutionRecord[]>;
  putResolution(record: ResolutionRecord): Promise<void>;
  clearResolutions(): Promise<void>;

  listProblems(): Promise<Problem[]>;
  putProblem(problem: Problem): Promise<void>;
  removeProblem(id: string): Promise<void>;

  getDraft(entityId: string): Promise<NoteDraft | undefined>;
  putDraft(draft: NoteDraft): Promise<void>;
  removeDraft(entityId: string): Promise<void>;
}

/**
 * The durable local database. `transaction` is all-or-nothing: if `fn` throws (or the host
 * crashes) nothing it wrote is visible afterwards. Transactions never run concurrently.
 */
export interface LocalStore {
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>;
}
