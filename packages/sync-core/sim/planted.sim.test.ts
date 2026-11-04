/**
 * Mutation check of the harness itself: each planted defect (in the model server or, through
 * `PlantedBugs`, in the client core) must make the NAMED invariant fail, and the failure must
 * reproduce from its seed. A harness that cannot fail proves nothing (docs/TESTING.md 10.2).
 */
import type { PlantedBugs } from "../src/engine.ts";
import { ModelServer, type ServerBugs } from "./model/server.ts";
import { runWorld } from "./run.ts";
import { SimFailure, type SimConfig } from "./world.ts";

const BASE: Partial<SimConfig> = { steps: 150, kinds: ["task", "project", "note"], resolutions: true };

interface Case {
  name: string;
  server?: ServerBugs;
  client?: PlantedBugs;
  config?: Partial<SimConfig>;
  /** invariant that must trip, and a seed known to trip it (the search starts there) */
  invariant: string;
  seed: number;
}

const CASES: Case[] = [
  { name: "server: ignores idempotency keys", server: { ignoreIdempotency: true }, invariant: "no_duplicates", seed: 5 },
  { name: "server: acknowledges a patch it did not apply", server: { ackButDropWrite: true }, invariant: "no_acknowledged_loss", seed: 0 },
  { name: "server: orders writes by client time", server: { lwwByClientTime: true }, invariant: "no_acknowledged_loss", seed: 1 },
  { name: "server: skips a feed row", server: { skipFeedRow: true }, invariant: "convergence", seed: 0 },
  { name: "server: feed cursor skips a row", server: { feedCursorSkips: true }, invariant: "cursor_safety", seed: 0 },
  { name: "server: merges without field revisions", server: { mergeIgnoresFieldRevisions: true }, invariant: "no_silent_text_loss", seed: 0 },
  { name: "server: a stale delete wins", server: { staleDeleteWins: true }, invariant: "edit_wins", seed: 3 },
  { name: "server: an edit of a deleted entity is 404", server: { noRevive: true }, invariant: "unexpected_rejection", seed: 3 },
  { name: "server: the snapshot omits an entity", server: { snapshotSkipsEntity: true }, config: { lateJoiner: true }, invariant: "cursor_safety", seed: 0 },
  { name: "server: accepts any protocol", server: { acceptsAnyProtocol: true }, config: { oldClient: true }, invariant: "stop_on_426", seed: 0 },
  { name: "server: a stale note save overwrites", server: { notesOverwriteOnStale: true }, invariant: "no_acknowledged_note_loss", seed: 0 },
  { name: "server: a merged save drops the client's edit", server: { notesMergeDropsOurs: true }, invariant: "no_acknowledged_loss", seed: 0 },
  { name: "server: acknowledges a note save it did not apply", server: { notesDropAcknowledgedWrite: true }, invariant: "no_acknowledged_loss", seed: 0 },
  { name: "server: paths differing by case collide", server: { notesIgnorePathCollisions: true }, invariant: "unique_paths", seed: 0 },
  { name: "server: a conflict copy is truncated", server: { notesConflictCopyTruncated: true }, invariant: "conflict_copy_has_losing_text", seed: 2 },
  { name: "server: a replayed write logs its resolutions again", server: { resLoggedOnReplay: true }, config: { steps: 300, clients: 4 }, invariant: "resolution_logged_once", seed: 249 },
  { name: "server: a resolution is reported but not logged", server: { resNotLogged: true }, invariant: "resolution_logged_once", seed: 0 },
  { name: "server: a refused delete logs a resolution", server: { resLoggedWithoutWrite: true }, invariant: "no_log_without_write", seed: 8 },
  { name: "server: a resolution is not announced on the feed", server: { resNotAnnounced: true }, invariant: "resolutions_converge", seed: 0 },
  { name: "server: the log keeps note text", server: { resKeepsText: true }, invariant: "log_has_no_text", seed: 0 },
  { name: "server: undo ignores a newer change", server: { undoIgnoresNewerChange: true }, invariant: "undo_never_overwrites_newer", seed: 5 },
  { name: "server: a resolution can be undone twice", server: { undoTwice: true }, invariant: "undo_once", seed: 5 },
  { name: "server: an undo is not logged", server: { undoNotLogged: true }, invariant: "undo_logged", seed: 5 },
  { name: "server: an undo is not idempotent", server: { undoNotIdempotent: true }, invariant: "undo_idempotent", seed: 22 },
  { name: "client: advances the cursor before applying the page", client: { advanceCursorBeforeApply: true }, config: { pStoreCrash: 0.15 }, invariant: "cursor_safety", seed: 0 },
  { name: "client: a retry gets a new idempotency key", client: { regenKeyOnRetry: true }, invariant: "idempotency_key_stability", seed: 0 },
  { name: "client: a retry takes a fresh base (not byte-identical)", client: { rebaseFrozenOps: true }, invariant: "idempotency_key_stability", seed: 2 },
  { name: "client: ignores tombstones", client: { ignoreTombstones: true }, invariant: "cursor_safety", seed: 0 },
  { name: "client: installs an acknowledgement as current state", client: { trustAckState: true }, invariant: "cursor_safety", seed: 33 },
  { name: "client: orders the queue by its own (skewed) clock", client: { orderQueueByWallClock: true }, invariant: "unexpected_rejection", seed: 28 },
  { name: "client: keeps going after a 426", client: { ignore426: true }, config: { oldClient: true }, invariant: "bounded_work", seed: 0 },
  { name: "client: keeps going after the device was revoked", client: { ignoreRevoked: true }, config: { revokeClient: "c2" }, invariant: "bounded_work", seed: 0 },
];

async function trip(c: Case, from: number, tries = 3): Promise<SimFailure | null> {
  for (let seed = from; seed < from + tries; seed++) {
    try {
      await runWorld(seed, new ModelServer(c.server), { ...BASE, ...c.config }, c.client);
    } catch (error) {
      if (error instanceof SimFailure) return error;
      throw error;
    }
  }
  return null;
}

describe("planted defects are caught by the named invariant", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const failure = await trip(c, c.seed);
      expect(failure, "the defect went unnoticed").not.toBeNull();
      expect(failure!.invariant).toBe(c.invariant);
    });
  }

  it("a failure reproduces from its printed seed", async () => {
    const c = CASES[0]!;
    const first = (await trip(c, c.seed))!;
    expect(first.message).toContain(`seed=${first.seed}`);
    expect(first.message).toContain(`ATLAS_SYNC_SEED=${first.seed}`);
    const again = await trip(c, first.seed, 1);
    expect(again!.message).toBe(first.message);
  });

  it("an honest run with the same settings passes", async () => {
    await runWorld(5, new ModelServer(), BASE);
  });
});
