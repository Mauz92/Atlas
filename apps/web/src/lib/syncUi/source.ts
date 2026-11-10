/**
 * Where the "changed on another device" UI gets its data (SYNC-11a/c, ADR-0070).
 *
 * The components never know whether they run over REST (a browser, and the desktop shell for the
 * web UI's own calls) or over the sync-core engine's local store (the desktop shell, 11c). A source
 * answers four questions and turns its transport's answers into the same {@link UndoOutcome}.
 */
import {
  ApiError,
  devicesApi,
  resolutionsApi,
  type Resolution,
} from "../../api/client";
import { desktopApi } from "../desktop";
import { newIdempotencyKey } from "../offlineQueue";
import { createEngineSource } from "./engineSource";
import { undoRefused, undoSucceeded, type UndoOutcome } from "./undoOutcome";
import type { ResolutionLike } from "./resolutionText";

export interface ResolutionPage<T extends ResolutionLike = Resolution> {
  items: T[];
  /** Opaque; pass back for the next (older) page. `null` at the end. */
  next: string | null;
}

export interface ResolutionsSource {
  readonly kind: "rest" | "engine";
  /** This device's id; `null` in a browser. */
  ownDeviceId(): Promise<string | null>;
  /** Names of the account's devices, when this client is allowed to list them (a browser is; a device token is not). */
  deviceNames(): Promise<Map<string, string>>;
  page(cursor: string | null, limit: number): Promise<ResolutionPage>;
  /** `key` stays the same for every retry of one tap, so a retry cannot undo twice. */
  undo(resolution: Resolution, key: string): Promise<UndoOutcome>;
}

/** One idempotency key per resolution until it has a definite answer. */
export class UndoKeys {
  private readonly keys = new Map<string, string>();
  keyFor(id: string): string {
    let key = this.keys.get(id);
    if (!key) {
      key = newIdempotencyKey();
      this.keys.set(id, key);
    }
    return key;
  }
  settle(id: string): void {
    this.keys.delete(id);
  }
}

export function createRestSource(): ResolutionsSource {
  return {
    kind: "rest",
    async ownDeviceId() {
      const desktop = desktopApi();
      if (!desktop) return null;
      try {
        return (await desktop.snapshot()).session?.device?.id ?? null;
      } catch {
        return null;
      }
    },
    async deviceNames() {
      const names = new Map<string, string>();
      const desktop = desktopApi();
      if (desktop) {
        try {
          const device = (await desktop.snapshot()).session?.device;
          if (device) names.set(device.id, device.name);
        } catch {
          // generic wording is enough
        }
        return names; // a device token may not list devices (T22)
      }
      try {
        for (const device of (await devicesApi.list()).items) names.set(device.id, device.name);
      } catch {
        // the notices still read: "another device"
      }
      return names;
    },
    async page(cursor, limit) {
      const answer = await resolutionsApi.list({ cursor, limit });
      return { items: answer.resolutions, next: answer.next_cursor ?? null };
    },
    async undo(resolution, key) {
      try {
        const done = await resolutionsApi.undo(resolution.id, key);
        return undoSucceeded(resolution, done.applied);
      } catch (error) {
        if (error instanceof ApiError) return undoRefused(resolution, error.status, error.body);
        return undoRefused(resolution, 0, null);
      }
    },
  };
}

let shared: ResolutionsSource | null = null;

/** The source for this runtime: the engine in the desktop shell (SYNC-11c), REST in a browser. */
export function defaultResolutionsSource(): ResolutionsSource {
  if (!shared) {
    const desktop = desktopApi();
    shared = desktop ? createEngineSource(desktop) : createRestSource();
  }
  return shared;
}

/** Tests and the shell choose the source. */
export function setDefaultResolutionsSource(source: ResolutionsSource | null): void {
  shared = source;
}
