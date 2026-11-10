/**
 * The resolutions source of the desktop shell (SYNC-11c): the sync-core engine's local store, reached
 * through the bridge's `sync` verbs. Entries are already held on this device (they arrive with the
 * feed), so the list works offline; an undo goes through the engine's durable queue and its answer is
 * the server's, worded by the same functions as the REST source.
 */
import type { Resolution } from "../../api/client";
import type { AtlasDesktopApi } from "../desktop";
import type { ResolutionsSource } from "./source";
import { undoRefused, undoSucceeded, type UndoOutcome } from "./undoOutcome";

export function createEngineSource(desktop: AtlasDesktopApi): ResolutionsSource {
  return {
    kind: "engine",
    async ownDeviceId() {
      return (await desktop.snapshot()).session?.device?.id ?? null;
    },
    async deviceNames() {
      // a device token may not list devices (T22, R-74): only this device's own name is known
      const device = (await desktop.snapshot()).session?.device;
      return new Map(device ? [[device.id, device.name]] : []);
    },
    async page(cursor, limit) {
      const all = await desktop.sync.resolutions();
      const offset = cursor === null ? 0 : Number(cursor) || 0;
      const items = all.slice(offset, offset + limit);
      return { items, next: offset + limit < all.length ? String(offset + limit) : null };
    },
    async undo(resolution: Resolution): Promise<UndoOutcome> {
      // the engine keeps one idempotency key per queued undo itself, so the page's key is not needed
      try {
        const answer = await desktop.sync.undo(resolution.id);
        if ("queued" in answer) {
          return {
            kind: "queued",
            message: "You are offline or the server is slow. The undo is saved and will be tried when the connection returns; Atlas will tell you if it can no longer be applied.",
            safe: true,
            refresh: false,
            followUp: null,
          };
        }
        const body = answer.body as { applied?: boolean } | null;
        if (answer.status >= 200 && answer.status < 300) return undoSucceeded(resolution, body?.applied !== false);
        return undoRefused(resolution, answer.status, answer.body);
      } catch {
        return undoRefused(resolution, 0, null);
      }
    },
  };
}
