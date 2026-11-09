/**
 * A scripted two-device REMINDER scenario that runs the REAL sync-core against any {@link ServerPort}
 * and returns normalised outcomes (statuses, states, the R-68 clamp). Running it on the model server
 * and on the real API and comparing the lists is the conformance check for the `reminder` entity,
 * the actions endpoint and `acted_at`: it fails when the model drifts from the shipped server.
 *
 * The two servers compute `remind_at` differently (the model fires at the due instant, the real one
 * applies the owner's default timing), so the outcomes never print an absolute `remind_at`; they print
 * states, revisions and offsets relative to "now" (rounded to the minute).
 */
import { SyncEngine, type EngineObserver } from "../src/engine.ts";
import type { Transport } from "../src/ports.ts";
import { fixedClock, seededRandom, sequenceIds, silentLogger } from "../src/testing/fakes.ts";
import { MemoryStore } from "../src/testing/memoryStore.ts";
import { toReq, toResponse, type ServerPort } from "./engineBridge.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const minutes = (ms: number): number => Math.round(ms / 60_000);

export async function runReminderScenario(port: ServerPort, serverNow: () => number = Date.now): Promise<string[]> {
  const outcomes: string[] = [];
  const clock = fixedClock();
  clock.wall = serverNow(); // the device clock reads the same instant as the server's
  const mk = (cid: string, seed: number) => {
    const transport: Transport = {
      send: async (request) => toResponse(await port.handle(toReq(request, { "X-Sim-Client": cid }))),
    };
    const observer: EngineObserver = {
      ack: (op, r) => {
        if (op.type !== "reminder") return;
        const body = r.body as { applied?: boolean; stale?: boolean } | null;
        outcomes.push(`${cid} ${String(op.fields["kind"])} -> ${r.status} applied=${String(body?.applied)} stale=${String(body?.stale)}`);
      },
      refused: (op, r) => {
        if (op.type !== "reminder") return;
        outcomes.push(`${cid} ${String(op.fields["kind"])} -> ${r.status} ${(r.body as { error?: string } | null)?.error ?? ""}`);
      },
    };
    return new SyncEngine({
      store: new MemoryStore(), transport, clock, ids: sequenceIds(seed), random: seededRandom(seed), logger: silentLogger, observer,
      options: { pullIntervalMs: 1_000_000, pullJitterMs: 0, resyncMinIntervalMs: 0, reminders: true },
    });
  };
  const a = mk("A", 11);
  const b = mk("B", 22);
  const settle = async () => {
    for (let round = 0; round < 4; round++) {
      for (const e of [a, b]) {
        e.requestPull();
        await e.syncUntilSettled(200);
      }
    }
  };
  const first = async (e: SyncEngine) => {
    const view = (await e.reminderViews())[0];
    if (!view) throw new Error("no reminder");
    return view.reminder;
  };
  const ids = sequenceIds(33); // the server wants a UUID as the action id
  const act = async (e: SyncEngine, kind: "snooze" | "dismiss", extra: { seconds?: 600 | 3600; actedAt?: number; baseRevision?: number; id?: string } = {}) => {
    const r = await first(e);
    await e.submitReminderAction({
      actionId: extra.id ?? ids.uuid(),
      reminderId: r.id,
      kind,
      ...(kind === "snooze" ? { snooze: { kind: "seconds" as const, seconds: extra.seconds ?? 600 } } : {}),
      baseRevision: extra.baseRevision ?? r.revision,
      ...(extra.actedAt !== undefined ? { actedAt: extra.actedAt } : {}),
    });
    await e.syncUntilSettled(200);
    await settle();
  };

  const now = serverNow();
  // 1-3: the entity follows the task
  const t = await a.createEntity("task", { title: "t0", description: null, due_at: new Date(now + 2 * HOUR).toISOString(), status: "inbox" });
  await settle();
  let r = await first(b);
  outcomes.push(`created: B holds an ${r.state} reminder at revision ${r.revision}`);
  await a.updateEntity("task", t, { status: "completed" });
  await settle();
  r = await first(b);
  outcomes.push(`completed: ${r.state} at revision ${r.revision}`);
  await a.updateEntity("task", t, { status: "in_progress" });
  await settle();
  r = await first(b);
  outcomes.push(`reopened: ${r.state} at revision ${r.revision}`);

  // 4: a snooze tapped 4 h ago, synced now: it counts from the tap and is already over
  const tapped = now - 4 * HOUR;
  await act(b, "snooze", { seconds: 3600, actedAt: tapped });
  r = await first(a);
  const until = Date.parse(r.snoozedUntil!);
  outcomes.push(`late snooze: ends ${minutes(until - tapped)} min after the tap, already over=${String(until < serverNow())}`);

  // 5-6: acted_at is clamped, never refused
  await act(b, "snooze", { seconds: 600, actedAt: now + 3 * DAY });
  r = await first(a);
  outcomes.push(`acted_at 3 days ahead: snooze ends ${minutes(Date.parse(r.snoozedUntil!) - serverNow())} min from now`);
  await act(b, "snooze", { seconds: 600, actedAt: now - 9 * DAY });
  r = await first(a);
  outcomes.push(`acted_at 9 days ago: snooze ended ${Math.round((serverNow() - Date.parse(r.snoozedUntil!)) / HOUR)} h ago`);

  // 7-8: dismiss, replay, then a snooze re-arms
  const dismissedInstant = Date.parse((await first(a)).snoozedUntil!); // the occurrence the dismissal covers
  const dismissId = ids.uuid();
  const dismissBase = (await first(b)).revision;
  await act(b, "dismiss", { id: dismissId, baseRevision: dismissBase });
  r = await first(a);
  const revision = r.revision;
  outcomes.push(`dismissed: acknowledgement covers the dismissed instant=${String(r.acknowledgedAt !== null && Date.parse(r.acknowledgedAt) >= dismissedInstant)} snooze cleared=${String(r.snoozedUntil === null)}`);
  await act(b, "dismiss", { id: dismissId, baseRevision: dismissBase }); // byte-identical: a true replay
  r = await first(a);
  outcomes.push(`replayed dismiss: revision unchanged=${String(r.revision === revision)}`);
  await act(a, "snooze", { seconds: 600 });
  r = await first(b);
  outcomes.push(`snooze after dismiss: acknowledgement cleared=${String(r.acknowledgedAt === null)} snooze set=${String(r.snoozedUntil !== null)}`);

  // 9: a device that claims to know a revision the server never produced is refused
  await act(a, "dismiss", { baseRevision: 999 });
  const problems = await a.problems();
  outcomes.push(`base_revision ahead: problem=${problems.map((p) => `${p.status}/${p.code}`).join(",")}`);
  return outcomes;
}
