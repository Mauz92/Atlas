/**
 * Mutation check of the harness itself: each planted defect in the scheduler (`PlantedBugs`) must
 * make the NAMED invariant fail, and the failure must reproduce from its seed. A simulation that
 * cannot fail proves nothing (docs/TESTING.md 10.2, 12.2).
 */
import type { PlantedBugs } from "../src/desired.ts";
import { SimFailure, runWorld } from "./world.ts";

interface Case {
  name: string;
  bugs: PlantedBugs;
  /** the invariant(s) that may name it: the first to trip wins, an earlier check can pre-empt */
  invariants: string[];
}

const CASES: Case[] = [
  {
    name: "writes the fired key after showing (a crash in between duplicates)",
    bugs: { writeFiredAfterShow: true },
    invariants: ["at_most_once"],
  },
  {
    name: "forgets the fired set after a restart",
    bugs: { forgetFiredOnRestart: true },
    invariants: ["at_most_once"],
  },
  {
    name: "ignores a dismissal made on another device",
    bugs: { ignoreAcknowledged: true },
    invariants: ["no_stale_show", "no_orphan_alarm"],
  },
  {
    name: "leaves the alarm of a cancelled or completed reminder armed",
    bugs: { keepAlarmOfCancelled: true },
    invariants: ["no_stale_show", "no_orphan_alarm"],
  },
  {
    name: "does not withdraw the alarm after an offline re-date",
    bugs: { ignoreDirtyTask: true },
    invariants: ["no_stale_show", "no_orphan_alarm"],
  },
  {
    name: "does not catch up a reminder that was due while the device was off",
    bugs: { skipCatchUp: true },
    invariants: ["nothing_lost"],
  },
  {
    name: "keys ignore the snooze (a snoozed reminder never rings again)",
    bugs: { keyIgnoresSnooze: true },
    invariants: ["nothing_lost", "no_orphan_alarm"],
  },
];

async function trip(bugs: PlantedBugs, tries = 80): Promise<SimFailure | null> {
  for (let seed = 0; seed < tries; seed++) {
    try {
      await runWorld(seed, { steps: 200 }, bugs);
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
      const failure = await trip(c.bugs);
      expect(failure, "the defect went unnoticed").not.toBeNull();
      expect(c.invariants).toContain(failure!.invariant);
    }, 120_000);
  }

  it("a failure prints its seed and reproduces from it", async () => {
    const first = (await trip({ ignoreAcknowledged: true }))!;
    expect(first.message).toContain(`seed=${first.seed}`);
    expect(first.message).toContain(`ATLAS_REMINDER_SEED=${first.seed}`);
    let again: SimFailure | null = null;
    try {
      await runWorld(first.seed, { steps: 200 }, { ignoreAcknowledged: true });
    } catch (error) {
      again = error as SimFailure;
    }
    expect(again?.message).toBe(first.message);
  });

  it("an honest run with the same settings passes", async () => {
    for (let seed = 0; seed < 10; seed++) await runWorld(seed, { steps: 200 });
  });
});
