/**
 * Mutation check of the reminder harness (M8-04b-ii): each planted defect, in the model server, in
 * the sync-core client or in the scheduler, must make the NAMED invariant fail, and the failure must
 * print its seed. A harness that cannot fail proves nothing (docs/TESTING.md 10.2, 12.2).
 */
import type { PlantedBugs } from "../src/engine.ts";
import type { PlantedBugs as SchedulerBugs } from "../../reminder-core/src/desired.ts";
import { ModelServer, type ServerBugs } from "./model/server.ts";
import { REMINDER_BASE } from "./reminderConfig.ts";
import { runWorld } from "./run.ts";
import { SimFailure, type SimConfig } from "./world.ts";

interface Case {
  name: string;
  server?: ServerBugs;
  client?: PlantedBugs;
  scheduler?: SchedulerBugs;
  config?: Partial<SimConfig>;
  /** the invariant that must trip; a list when the defect legitimately shows in more than one */
  invariant: string | string[];
  seed: number;
  tries?: number;
}

const CASES: Case[] = [
  { name: "server: a reminder change is not announced on the feed", server: { reminderNotAnnounced: true }, invariant: "reminders_converge", seed: 0 },
  { name: "server: acted_at is ignored (the late snooze counts from the sync)", server: { actedAtIgnored: true }, config: { pToggleOnline: 0.1 }, invariant: "snooze_counts_from_the_tap", seed: 0 },
  { name: "server: acted_at is not clamped", server: { actedAtUnclamped: true }, invariant: "acted_at_clamped", seed: 0 },
  { name: "server: a replayed action is applied again", server: { actionNotIdempotent: true }, config: { pDuplicate: 0.2, pDropResponse: 0.25 }, invariant: ["action_applied_once", "dismissal_syncs"], seed: 0, tries: 30 },
  { name: "server: a dismissal is acknowledged but not recorded", server: { dismissNotRecorded: true }, invariant: "dismissal_syncs", seed: 0 },
  { name: "server: the type walk omits a reminder", server: { reminderSnapshotSkips: true }, config: { reminderUpgrade: true, clients: 4 }, invariant: "cursor_safety", seed: 0 },
  { name: "server: completing a task does not cancel its reminder", server: { completionKeepsReminder: true }, invariant: "reminder_follows_task", seed: 0 },
  { name: "client: a type new to it is recorded as synced without the backfill", client: { typeSyncedWithoutBackfill: true }, config: { reminderUpgrade: true, clients: 4 }, invariant: "cursor_safety", seed: 0 },
  { name: "client: a local re-dating does not mark the task dirty", client: { ignoreDirtyTask: true }, invariant: "no_stale_show", seed: 0, tries: 20 },
  { name: "client: dirty is dropped at the acknowledgement, not after the next pull", client: { clearDirtyAtAck: true }, invariant: "no_stale_show", seed: 0, tries: 60 },
  { name: "client: a late action is sent without acted_at", client: { omitActedAt: true }, config: { pToggleOnline: 0.1 }, invariant: "acted_at_sent", seed: 0 },
  { name: "scheduler: a dismissal on another device does not stop the notification", scheduler: { ignoreAcknowledged: true }, config: { pToggleOnline: 0.15, clients: 4 }, invariant: "no_stale_show", seed: 0, tries: 40 },
  { name: "scheduler: an alarm survives the cancellation of its reminder", scheduler: { keepAlarmOfCancelled: true }, invariant: ["no_stale_show", "at_most_once"], seed: 0, tries: 20 },
  { name: "scheduler: the key ignores the snooze", scheduler: { keyIgnoresSnooze: true }, config: { actionP: 0.7 }, invariant: "nothing_lost", seed: 0, tries: 30 },
  { name: "scheduler: a past-due reminder is not caught up", scheduler: { skipCatchUp: true }, config: { pToggleOnline: 0.1 }, invariant: "nothing_lost", seed: 0, tries: 30 },
  { name: "scheduler: the fired set is forgotten on restart", scheduler: { forgetFiredOnRestart: true }, invariant: "at_most_once", seed: 0, tries: 20 },
];

async function trip(c: Case, from: number, tries = c.tries ?? 10): Promise<SimFailure | null> {
  for (let seed = from; seed < from + tries; seed++) {
    try {
      await runWorld(
        seed,
        new ModelServer(c.server, { reminders: true }),
        { steps: 150, ...REMINDER_BASE, ...c.config, schedulerBugs: c.scheduler ?? {} },
        c.client,
      );
    } catch (error) {
      if (error instanceof SimFailure) return error;
      throw error;
    }
  }
  return null;
}

describe("planted reminder defects are caught by the named invariant", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const failure = await trip(c, c.seed);
      expect(failure, "the defect went unnoticed").not.toBeNull();
      expect([c.invariant].flat()).toContain(failure!.invariant);
    });
  }

  it("a failure prints its seed and reproduces from it", async () => {
    const c = CASES[0]!;
    const first = (await trip(c, c.seed))!;
    expect(first.message).toContain(`seed=${first.seed}`);
    expect(first.message).toContain(`ATLAS_SYNC_SEED=${first.seed}`);
    const again = await trip(c, first.seed, 1);
    expect(again!.message).toBe(first.message);
  });

  it("an honest run with the same settings passes", async () => {
    await runWorld(5, new ModelServer({}, { reminders: true }), { steps: 150, ...REMINDER_BASE });
  });
});
