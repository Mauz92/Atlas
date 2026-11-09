/**
 * The reminder invariants (M8-04b-ii; docs/TESTING.md 12.2 and 10.2). Judged against the harness's
 * own record of what the owner did on each device and against the server's truth, never against the
 * code under test. Every failure is a `SimFailure` carrying the seed.
 *
 *  - `at_most_once`            a notification key is shown at most once per device, across restarts and sync
 *  - `fired_not_early`         nothing is shown before its instant (by the device clock)
 *  - `no_stale_show`           nothing is shown that the device knew was cancelled, completed, dismissed,
 *                              acknowledged, re-dated (until the server recomputed it) or not the current instant
 *  - `reminders_converge`      every device's mirror equals the server's reminders
 *  - `nothing_lost`            every armed, open, un-dismissed reminder due within the horizon was shown
 *  - `no_orphan_alarm`         no alarm is left armed for a reminder that must not fire
 *  - `acted_at_sent`           an action that waited at least a minute carries the tap time; a prompt one does not
 *  - `snooze_counts_from_the_tap` (model) the snooze instant is the clamped tap time plus the duration (R-68)
 *  - `acted_at_clamped`        (model) the base of an action lies inside the safe window around server time
 *  - `action_applied_once`     (model) a replayed action changes the reminder at most once
 */

import { ACTED_AT_MIN_DELAY_MS } from "../src/engine.ts";
import { toReminderRecord, type ReminderRecordData } from "../src/reminders.ts";
import { ACTED_AT_MAX_AGE_MS, ACTED_AT_MAX_FUTURE_MS, DELIVERABLE } from "./model/server.ts";
import { DAY, HOUR, type ReminderDevice } from "./reminderDevice.ts";
import type { SimClient, World } from "./world.ts";

const idOf = (key: string): string => key.slice(0, key.indexOf(":"));
const instantOf = (key: string): number => Date.parse(key.slice(key.indexOf(":") + 1));
const isoOf = (ms: number): string => new Date(ms).toISOString();

function mirror(client: SimClient, reminderId: string): ReminderRecordData | null {
  const entity = client.store.peek().entities.get(reminderId);
  return entity ? toReminderRecord(entity) : null;
}

async function taskClosed(client: SimClient, taskId: string): Promise<boolean> {
  const view = (await client.engine.views()).find((v) => v.id === taskId);
  if (!view) return false; // not known here: the server's `armed` stands
  const status = view.fields["status"];
  return view.deleted || (typeof status === "string" && !(DELIVERABLE as readonly string[]).includes(status));
}

/** Why a show of `key` on this device is not legitimate, or `null` when it is. */
export async function whyStale(client: SimClient, dev: ReminderDevice, key: string): Promise<string | null> {
  const rid = idOf(key);
  const instant = instantOf(key);
  const rec = mirror(client, rid);
  if (!rec) return "the device holds no such reminder";
  if (rec.state !== "armed") return `the mirror says the reminder is ${rec.state}`;
  if (dev.dismissed.has(key)) return "the owner dismissed exactly this notification on this device";
  if (await taskClosed(client, rec.taskId)) return "the task is completed, archived or deleted on this device";
  const ownSnooze = [...dev.taps.values()].some(
    (t) => t.kind === "snooze" && t.reminderId === rid && t.seconds !== null && t.deviceTime + t.seconds * 1000 === instant,
  );
  if (!ownSnooze) {
    if (Date.parse(rec.effectiveAt) !== instant) return `the mirror's instant is ${rec.effectiveAt}, not ${isoOf(instant)}`;
    if (rec.acknowledgedAt !== null && Date.parse(rec.acknowledgedAt) >= instant)
      return `it was dismissed (acknowledged at ${rec.acknowledgedAt})`;
  }
  for (const redate of dev.redates) {
    if (redate.taskId === rec.taskId && !redate.done && redate.oldInstants.has(isoOf(instant)))
      return "the owner re-dated the task here and the server's recomputation has not arrived: this is the OLD instant";
  }
  return null;
}

/** Judge what a device showed since the last call. */
export async function checkReminderStep(world: World, client: SimClient): Promise<void> {
  const dev = client.device;
  if (!dev) return;
  dev.settleRedates([...client.store.peek().queue.values()]);
  const history = dev.os.history;
  const seen = new Map<string, number>();
  for (const h of history) {
    if (h.key === null) continue;
    seen.set(h.key, (seen.get(h.key) ?? 0) + 1);
  }
  for (const [key, n] of seen) {
    if (n > 1) throw world.fail("at_most_once", `${client.cid} showed ${key} ${n} times`);
  }
  for (const h of history.slice(dev.judged)) {
    if (h.key === null) continue;
    if (h.at < instantOf(h.key))
      throw world.fail("fired_not_early", `${client.cid} showed ${h.key} at ${isoOf(h.at)}, before its instant`);
    const why = await whyStale(client, dev, h.key);
    if (why)
      throw world.fail(
        "no_stale_show",
        `${client.cid} showed ${h.key} via ${h.via} at ${isoOf(h.at)}: ${why}\n  mirror=${JSON.stringify(mirror(client, idOf(h.key)))}`,
      );
  }
  dev.judged = history.length;
}

/** The server's reminders, read through the API (the same call on the model and the real server). */
export async function reminderTruth(world: World): Promise<Map<string, Record<string, unknown>>> {
  const resp = await world.server.handle({
    method: "GET", path: "/api/reminders", params: { limit: 500 }, body: null, headers: { "Atlas-Sync": "1" },
  });
  if (resp.status !== 200) throw world.fail("harness", `listing reminders returned ${resp.status}`);
  const out = new Map<string, Record<string, unknown>>();
  for (const row of (resp.body as { reminders: Record<string, unknown>[] }).reminders) out.set(row["id"] as string, row);
  return out;
}

/** The keys a device owes the owner at quiescence. */
function owedKeys(truth: Map<string, Record<string, unknown>>, dev: ReminderDevice, now: number, openTasks: Set<string>): string[] {
  const owed: string[] = [];
  for (const row of truth.values()) {
    if (row["state"] !== "armed" || !openTasks.has(row["task_id"] as string)) continue;
    const effective = Date.parse(row["effective_at"] as string);
    const ack = row["acknowledged_at"] === null ? null : Date.parse(row["acknowledged_at"] as string);
    if (ack !== null && ack >= effective) continue;
    if (effective < now - DAY || effective > now + 10 * DAY) continue;
    if ([...dev.taps.values()].some((t) => t.reminderId === row["id"])) continue; // it acted on it itself (suppression rules)
    owed.push(`${row["id"] as string}:${isoOf(effective)}`);
  }
  return owed;
}

/** Everything that can only be judged once the clients have converged. */
export async function checkReminderQuiescent(world: World): Promise<void> {
  const truth = await reminderTruth(world);
  const model = world.model();
  // reminders_converge
  for (const client of world.clients) {
    if (client.halted || !client.device) continue;
    for (const [id, want] of truth) {
      const local = mirror(client, id);
      const ok =
        local !== null &&
        local.revision === want["revision"] &&
        local.state === want["state"] &&
        Date.parse(local.remindAt) === Date.parse(want["remind_at"] as string) &&
        (local.snoozedUntil === null ? want["snoozed_until"] === null : Date.parse(local.snoozedUntil) === Date.parse(want["snoozed_until"] as string)) &&
        (local.acknowledgedAt === null ? want["acknowledged_at"] === null : Date.parse(local.acknowledgedAt) === Date.parse(want["acknowledged_at"] as string));
      if (!ok)
        throw world.fail(
          "reminders_converge",
          `${client.cid} disagrees with the server about reminder ${id}: server ${JSON.stringify(want)}, client ${JSON.stringify(local)}`,
        );
    }
    for (const entity of client.store.peek().entities.values())
      if (entity.type === "reminder" && !entity.deleted && entity.server && !truth.has(entity.id))
        throw world.fail("reminders_converge", `${client.cid} still holds reminder ${entity.id} which the server does not list`);
  }
  if (model) {
    // reminder_follows_task: a reminder of a completed, archived or deleted task is cancelled
    for (const r of model.reminders.values()) {
      const task = model.entities.get(r.taskId);
      const closed = !task || task.deleted || !(DELIVERABLE as readonly unknown[]).includes(task.fields["status"]);
      if (r.state === "armed" && closed)
        throw world.fail("reminder_follows_task", `reminder ${r.id} is armed although its task is ${task?.deleted ? "deleted" : String(task?.fields["status"])}`);
    }
    for (const t of model.actions.values()) {
      if (t.applications > 1) throw world.fail("action_applied_once", `action ${t.actionId} changed the reminder ${t.applications} times`);
      const lo = t.serverNow - ACTED_AT_MAX_AGE_MS;
      const hi = t.serverNow + ACTED_AT_MAX_FUTURE_MS;
      if (t.base < lo || t.base > hi)
        throw world.fail("acted_at_clamped", `action ${t.actionId} was counted from ${isoOf(t.base)}, outside [now-24h, now+5min] around ${isoOf(t.serverNow)}`);
      if (t.kind === "snooze" && t.applied) {
        const expected = (t.actedAtSent === null ? t.serverNow : Math.min(Math.max(t.actedAtSent, lo), hi)) + t.seconds! * 1000;
        if (t.until !== expected)
          throw world.fail("snooze_counts_from_the_tap", `snooze ${t.actionId} ends at ${isoOf(t.until!)}, expected ${isoOf(expected)}`);
      }
    }
  }
  // dismissal_syncs: what the owner dismissed on a device is dismissed for everyone once it has synced
  for (const client of world.clients) {
    if (client.halted || !client.device) continue;
    for (const tap of client.device.taps.values()) {
      if (tap.kind !== "dismiss" || tap.key === null || !world.rec.firstSendByKey.has(tap.actionId)) continue;
      // A dismissal that reached a CANCELLED reminder changes nothing by design (14.5); if the task is
      // reopened later the reminder fires again. Only the model knows the state at that moment.
      if (!model || !model.actions.get(tap.actionId)?.armed) continue;
      const row = truth.get(idOf(tap.key));
      if (!row || row["state"] !== "armed") continue;
      const instant = instantOf(tap.key);
      const effective = Date.parse(row["effective_at"] as string);
      const ack = row["acknowledged_at"] === null ? null : Date.parse(row["acknowledged_at"] as string);
      if (effective === instant && !(ack !== null && ack >= instant))
        throw world.fail("dismissal_syncs", `${client.cid} dismissed ${tap.key} (action ${tap.actionId}) but the server still has it armed and unacknowledged: ${JSON.stringify(row)}`);
    }
  }
  // the client half of R-68: what each first send carried, against the tap (model or real server)
  for (const client of world.clients) {
    const dev = client.device;
    if (!dev) continue;
    for (const tap of dev.taps.values()) {
      const sent = world.rec.firstSendByKey.get(tap.actionId);
      if (!sent) continue; // never sent (halted or revoked)
      const waited = sent.wall - tap.deviceTime;
      const body = sent.body;
      if (waited >= ACTED_AT_MIN_DELAY_MS) {
        if (body["acted_at"] !== isoOf(tap.deviceTime))
          throw world.fail("acted_at_sent", `${client.cid}: action ${tap.actionId} waited ${Math.round(waited / 60000)} min but was sent with acted_at=${String(body["acted_at"])}, not the tap ${isoOf(tap.deviceTime)}`);
      } else if ("acted_at" in body) {
        throw world.fail("acted_at_sent", `${client.cid}: a prompt action ${tap.actionId} carried acted_at (waited ${waited} ms)`);
      }
    }
  }
}

/** After quiescence: the clock runs on with no more sync and nothing owed may be missing. */
export async function reminderSweep(world: World): Promise<void> {
  const truth = await reminderTruth(world);
  for (const client of world.clients) {
    const dev = client.device;
    if (!dev) continue;
    client.offset = 0;
    dev.os.permissionState = "granted";
    dev.os.powered = true;
    await dev.sched.updateSettings({ enabled: true });
    await dev.pump();
    await checkReminderStep(world, client);
  }
  const expected = new Map<ReminderDevice, string[]>();
  const t0 = world.remNow();
  for (const client of world.clients) {
    const dev = client.device;
    if (!dev || client.halted) continue;
    const open = new Set<string>();
    for (const view of await client.engine.views()) if (view.type === "task" && !(await taskClosed(client, view.id))) open.add(view.id);
    // a task the device never held cannot be judged: the server's armed state stands
    for (const row of truth.values()) if (!client.store.peek().entities.has(row["task_id"] as string)) open.add(row["task_id"] as string);
    expected.set(dev, owedKeys(truth, dev, t0, open));
  }
  for (let hour = 0; hour < 11 * 24; hour++) {
    world.sweep += HOUR;
    for (const client of world.clients) {
      if (!client.device) continue;
      await client.device.pump();
      await checkReminderStep(world, client);
    }
  }
  for (const client of world.clients) {
    const dev = client.device;
    if (!dev || client.halted) continue;
    for (const alarm of dev.os.alarms.values()) {
      const why = alarm.key === null ? null : await whyStale(client, dev, alarm.key);
      if (why) throw world.fail("no_orphan_alarm", `${client.cid} holds an alarm for ${alarm.key}: ${why}`);
    }
    const shownKeys = new Set(dev.os.history.map((h) => h.key));
    const summarised = dev.os.history.reduce((n, h) => {
      const m = /^(\d+) reminders are due$/.exec(h.body);
      return n + (h.key === null && m ? Number(m[1]) : 0);
    }, 0);
    const missing = (expected.get(dev) ?? []).filter((k) => !shownKeys.has(k));
    if (missing.length > summarised)
      throw world.fail("nothing_lost", `${client.cid} never showed ${missing.length - summarised} of: ${missing.join(", ")}`);
  }
}
