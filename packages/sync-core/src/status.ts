import type { Json } from "./types.ts";

/** Why syncing stopped and waits for a person (never retried blindly). */
export type Halt =
  | { kind: "update_required"; min: number | null; max: number | null }
  | { kind: "signed_out"; code: string }
  | {
      kind: "restore_confirmation";
      reason: "epoch_mismatch" | "cursor_ahead";
      /** The server's new epoch (epoch_mismatch) */
      epoch: string | null;
      /** The server's feed head (cursor_ahead) */
      head: number | null;
    };

export type SyncState =
  | "idle"
  | "syncing"
  | "offline"
  | "backoff"
  | "update_required"
  | "signed_out"
  | "restore_confirmation";

/** Observable state for a status surface (the data behind the UI, no wording). */
export interface SyncStatus {
  state: SyncState;
  halt: Halt | null;
  /** Operations the server has not acknowledged. */
  pending: number;
  /** Writes the server refused for good (kept as problems until dismissed). */
  failed: number;
  /** Writes with a conflict that kept both versions (until dismissed). */
  conflicts: number;
  /** Wall-clock time of the last completed pull, or `null`. */
  lastSyncAt: number | null;
  online: boolean;
  cursor: number;
  /** Consecutive failed attempts (0 when healthy). */
  failures: number;
  /** Monotonic time the next attempt is allowed, when waiting. */
  retryAt: number | null;
}

export function haltToJson(halt: Halt | null): Json {
  return halt === null ? null : (halt as unknown as Json);
}

export type StatusListener = (status: SyncStatus) => void;
